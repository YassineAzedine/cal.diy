import { ErrorWithCode } from "@calcom/lib/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SLOT_REQUEST_SCHEMA_NAME,
  SLOT_REQUEST_SYSTEM_PROMPT,
  slotRequestJsonSchema,
} from "../lib/slotRequestPrompt";
import type { IStructuredCompletionClient, StructuredCompletionRequest } from "./IStructuredCompletionClient";
import { LlmSlotRequestParser } from "./LlmSlotRequestParser";

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock("@calcom/lib/logger", () => ({
  default: { getSubLogger: () => ({ warn: mockWarn }) },
}));

const QUERY = "next tuesday afternoon with Jane Doe";
const input = { query: QUERY, today: "2026-10-09", timeZone: "Europe/Paris" };

const understoodOutput = {
  understood: true,
  dateFrom: "2026-10-13",
  dateTo: "2026-10-13",
  timeWindows: [{ from: "12:00", to: "17:00" }],
  weekdays: [],
  preference: "earliest",
};

const createParser = (complete: IStructuredCompletionClient["complete"]) => {
  const client = { complete: vi.fn(complete) };
  return { client, parser: new LlmSlotRequestParser({ client }) };
};

const respondWith = (content: string) => async () => ({ ok: true as const, content });

describe("LlmSlotRequestParser", () => {
  beforeEach(() => {
    mockWarn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("successful parses", () => {
    it("returns the validated request", async () => {
      const { parser } = createParser(respondWith(JSON.stringify(understoodOutput)));

      expect(await parser.parse(input)).toEqual({ status: "ok", request: understoodOutput });
    });

    it("sends the shared prompt, schema and limits to the client", async () => {
      const { client, parser } = createParser(respondWith(JSON.stringify(understoodOutput)));

      await parser.parse(input);

      const request: StructuredCompletionRequest = client.complete.mock.calls[0][0];
      expect(request).toMatchObject({
        systemPrompt: SLOT_REQUEST_SYSTEM_PROMPT,
        schemaName: SLOT_REQUEST_SCHEMA_NAME,
        jsonSchema: slotRequestJsonSchema,
        maxOutputTokens: 300,
      });
      expect(request.userMessage).toContain("Today: 2026-10-09 (Friday)");
      expect(request.userMessage).toContain(`<booker_request>\n${QUERY}\n</booker_request>`);
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.signal.aborted).toBe(false);
    });

    it.each([
      ["a json fence", (json: string) => `\`\`\`json\n${json}\n\`\`\``],
      ["an uppercase JSON fence", (json: string) => `\`\`\`JSON\n${json}\n\`\`\``],
      ["a bare fence", (json: string) => `\`\`\`\n${json}\n\`\`\``],
      ["a fence on one line with surrounding whitespace", (json: string) => `  \`\`\`json ${json} \`\`\`  `],
    ])("accepts JSON wrapped in %s", async (_, wrap) => {
      const { parser } = createParser(respondWith(wrap(JSON.stringify(understoodOutput))));

      expect(await parser.parse(input)).toEqual({ status: "ok", request: understoodOutput });
    });

    it("returns a not-understood request from the flat model output", async () => {
      const { parser } = createParser(
        respondWith(
          JSON.stringify({
            understood: false,
            dateFrom: null,
            dateTo: null,
            timeWindows: [],
            weekdays: [],
            preference: "earliest",
          })
        )
      );

      expect(await parser.parse(input)).toEqual({ status: "ok", request: { understood: false } });
    });

    it("drops fields the schema does not know, such as invented slots", async () => {
      const { parser } = createParser(
        respondWith(JSON.stringify({ ...understoodOutput, slots: ["2026-10-13T12:00:00Z"] }))
      );

      const result = await parser.parse(input);

      expect(result).toEqual({ status: "ok", request: understoodOutput });
    });
  });

  describe("empty input", () => {
    it.each([
      "",
      "   ",
      "​\n\t",
      "<>",
    ])("returns not understood without calling the provider for %j", async (query) => {
      const { client, parser } = createParser(respondWith(JSON.stringify(understoodOutput)));

      expect(await parser.parse({ ...input, query })).toEqual({
        status: "ok",
        request: { understood: false },
      });
      expect(client.complete).not.toHaveBeenCalled();
    });
  });

  describe("invalid model output", () => {
    it.each([
      ["malformed JSON", '{"understood": true,'],
      ["prose instead of JSON", "Sure! Tuesday afternoon works."],
      ["an empty object", "{}"],
      ["a natural-language date", JSON.stringify({ ...understoodOutput, dateFrom: "next tuesday" })],
      ["understood without dates", JSON.stringify({ ...understoodOutput, dateFrom: null, dateTo: null })],
      [
        "an invalid time",
        JSON.stringify({ ...understoodOutput, timeWindows: [{ from: "25:00", to: "26:00" }] }),
      ],
    ])("fails with invalid_output for %s", async (_, content) => {
      const { parser } = createParser(respondWith(content));

      expect(await parser.parse(input)).toEqual({ status: "failed", reason: "invalid_output" });
    });

    it("fails with invalid_output for oversized content", async () => {
      const { parser } = createParser(respondWith(" ".repeat(16_385)));

      expect(await parser.parse(input)).toEqual({ status: "failed", reason: "invalid_output" });
    });

    it.each([
      ["an unclosed fence followed by whitespace", `\`\`\`${" ".repeat(16_000)}x`],
      ["a fence full of backticks", `\`\`\`${" `".repeat(8_000)}`],
      ["a closed fence around whitespace", `\`\`\`json${" ".repeat(16_000)}\`\`\``],
    ])("rejects %s quickly instead of backtracking", async (_, content) => {
      const { parser } = createParser(respondWith(content));
      const startedAt = performance.now();

      expect(await parser.parse(input)).toEqual({ status: "failed", reason: "invalid_output" });
      // The previous regex took about 5 seconds at 4 KB and grew cubically; linear parsing takes milliseconds.
      expect(performance.now() - startedAt).toBeLessThan(500);
    });
  });

  describe("client failures", () => {
    it.each([
      ["timeout", "timeout"],
      ["provider_error", "provider_error"],
      ["invalid_response", "invalid_output"],
    ] as const)("maps the client failure %s to %s", async (clientReason, parserReason) => {
      const { parser } = createParser(async () => ({ ok: false, reason: clientReason, httpStatus: 502 }));

      expect(await parser.parse(input)).toEqual({ status: "failed", reason: parserReason });
    });

    it("fails with provider_error when a client throws despite its contract", async () => {
      const { parser } = createParser(async () => {
        throw new Error("socket hang up");
      });

      expect(await parser.parse(input)).toEqual({ status: "failed", reason: "provider_error" });
    });
  });

  describe("timeouts and cancellation", () => {
    it("bounds the provider call with the configured timeout", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const { parser } = createParser(respondWith(JSON.stringify(understoodOutput)));

      await parser.parse(input);

      expect(timeoutSpy).toHaveBeenCalledWith(5000);
    });

    it("passes the caller's cancellation through to the client", async () => {
      const controller = new AbortController();
      const { client, parser } = createParser(respondWith(JSON.stringify(understoodOutput)));

      await parser.parse({ ...input, signal: controller.signal });
      const { signal } = client.complete.mock.calls[0][0];
      controller.abort();

      expect(signal.aborted).toBe(true);
    });
  });

  describe("logging", () => {
    it("logs the failure reason without the booker's text or the model's answer", async () => {
      const modelAnswer = "I cannot help Jane Doe with that";
      const { parser } = createParser(respondWith(modelAnswer));

      await parser.parse(input);

      expect(mockWarn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(mockWarn.mock.calls);
      expect(logged).toContain("invalid_output");
      expect(logged).not.toContain("Jane Doe");
      expect(logged).not.toContain(modelAnswer);
    });

    it("logs safe provider details on client failure", async () => {
      const { parser } = createParser(async () => ({
        ok: false,
        reason: "provider_error",
        httpStatus: 429,
        providerErrorCode: 429,
      }));

      await parser.parse(input);

      expect(mockWarn.mock.calls[0][1]).toMatchObject({
        reason: "provider_error",
        httpStatus: 429,
        providerErrorCode: 429,
      });
    });
  });

  it("throws for an invalid today, which is a caller bug rather than a provider failure", async () => {
    const { client, parser } = createParser(respondWith(JSON.stringify(understoodOutput)));

    await expect(parser.parse({ ...input, today: "2026-10-9" })).rejects.toThrow(ErrorWithCode);
    expect(client.complete).not.toHaveBeenCalled();
  });
});
