import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StructuredCompletionRequest } from "../IStructuredCompletionClient";
import { createCompletionClient } from "./createCompletionClient";
import { OpenRouterCompletionClient } from "./OpenRouterCompletionClient";

const API_KEY = "sk-or-v1-secret-test-key";
const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "example-org/example-model";

const fetchMock = vi.fn<typeof fetch>();

const createClient = () => new OpenRouterCompletionClient({ apiKey: API_KEY, apiUrl: API_URL, model: MODEL });

const createRequest = (signal: AbortSignal = new AbortController().signal): StructuredCompletionRequest => ({
  systemPrompt: "system prompt",
  userMessage: "user message",
  schemaName: "slot_request",
  jsonSchema: { type: "object" },
  maxOutputTokens: 300,
  signal,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const completion = (content: string | null) => ({
  id: "gen-123",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
  usage: { prompt_tokens: 500, completion_tokens: 40 },
});

const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

describe("OpenRouterCompletionClient", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("request", () => {
    it("sends a structured-output chat completion with privacy-preserving routing", async () => {
      fetchMock.mockResolvedValue(jsonResponse(completion("{}")));
      const request = createRequest();

      await createClient().complete(request);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(API_URL);
      expect(init).toMatchObject({ method: "POST", redirect: "error", signal: request.signal });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: MODEL,
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "user message" },
        ],
        max_tokens: 300,
        response_format: {
          type: "json_schema",
          json_schema: { name: "slot_request", strict: true, schema: { type: "object" } },
        },
        provider: { require_parameters: true, data_collection: "deny" },
      });
    });

    it("sends only the auth and content-type headers, with no attribution headers", async () => {
      fetchMock.mockResolvedValue(jsonResponse(completion("{}")));

      await createClient().complete(createRequest());

      expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      });
    });
  });

  describe("successful responses", () => {
    it("returns the message content", async () => {
      fetchMock.mockResolvedValue(jsonResponse(completion('{"understood":false}')));

      expect(await createClient().complete(createRequest())).toEqual({
        ok: true,
        content: '{"understood":false}',
      });
    });

    it("reads a body delivered in several chunks", async () => {
      const body = JSON.stringify(completion('{"understood":false}'));
      fetchMock.mockResolvedValue(new Response(streamOf([body.slice(0, 10), body.slice(10)])));

      expect(await createClient().complete(createRequest())).toEqual({
        ok: true,
        content: '{"understood":false}',
      });
    });
  });

  describe("unusable responses", () => {
    it.each([
      ["null content", completion(null)],
      ["empty content", completion("")],
      ["no choices", { choices: [] }],
      ["an unexpected shape", { result: "ok" }],
    ])("returns invalid_response for %s", async (_, body) => {
      fetchMock.mockResolvedValue(jsonResponse(body));

      expect(await createClient().complete(createRequest())).toEqual({
        ok: false,
        reason: "invalid_response",
        httpStatus: 200,
      });
    });

    it("returns invalid_response for a body that is not JSON", async () => {
      fetchMock.mockResolvedValue(new Response("<html>gateway</html>", { status: 200 }));

      expect(await createClient().complete(createRequest())).toMatchObject({
        ok: false,
        reason: "invalid_response",
      });
    });

    // Both bodies below are otherwise valid completions, so only the size limit can reject them.
    it("rejects an oversized body announced by content-length without reading it", async () => {
      const response = new Response(JSON.stringify(completion("{}")), {
        headers: { "content-length": "100000" },
      });
      fetchMock.mockResolvedValue(response);

      expect(await createClient().complete(createRequest())).toEqual({
        ok: false,
        reason: "invalid_response",
        httpStatus: 200,
      });
    });

    it("stops reading an oversized streamed body", async () => {
      const body = JSON.stringify(completion(`{"padding":"${"x".repeat(20_000)}"}`));
      const pull = vi.fn();
      const chunks = body.match(/[\s\S]{1,1000}/g) ?? [];
      const encoder = new TextEncoder();
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pull();
          if (index < chunks.length) {
            controller.enqueue(encoder.encode(chunks[index++]));
          } else {
            controller.close();
          }
        },
      });
      fetchMock.mockResolvedValue(new Response(stream));

      expect(await createClient().complete(createRequest())).toEqual({
        ok: false,
        reason: "invalid_response",
        httpStatus: 200,
      });
      expect(pull.mock.calls.length).toBeLessThan(chunks.length);
    });

    it("accepts a valid body just under the size limit", async () => {
      const padding = "x".repeat(15_000);
      fetchMock.mockResolvedValue(jsonResponse(completion(`{"padding":"${padding}"}`)));

      expect(await createClient().complete(createRequest())).toMatchObject({ ok: true });
    });
  });

  describe("provider errors", () => {
    it("returns the status and error code but never the provider's message", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: { code: 401, message: `Invalid key ${API_KEY} for "Jane Doe"` } }, 401)
      );

      const result = await createClient().complete(createRequest());

      expect(result).toEqual({
        ok: false,
        reason: "provider_error",
        httpStatus: 401,
        providerErrorCode: 401,
      });
      expect(JSON.stringify(result)).not.toContain(API_KEY);
      expect(JSON.stringify(result)).not.toContain("Jane Doe");
    });

    it("treats an error envelope as a provider error even with a 200 status", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: { code: "no_provider_available", message: "..." } }));

      expect(await createClient().complete(createRequest())).toEqual({
        ok: false,
        reason: "provider_error",
        httpStatus: 200,
        providerErrorCode: "no_provider_available",
      });
    });

    it("returns provider_error for a non-JSON error page", async () => {
      fetchMock.mockResolvedValue(new Response("Bad gateway", { status: 502 }));

      expect(await createClient().complete(createRequest())).toEqual({
        ok: false,
        reason: "provider_error",
        httpStatus: 502,
        providerErrorCode: undefined,
      });
    });

    it("returns provider_error, not invalid_response, for an oversized error page", async () => {
      fetchMock.mockResolvedValue(new Response("x".repeat(20_000), { status: 503 }));

      expect(await createClient().complete(createRequest())).toEqual({
        ok: false,
        reason: "provider_error",
        httpStatus: 503,
      });
    });

    it("returns provider_error for a network failure without exposing its message", async () => {
      fetchMock.mockRejectedValue(new TypeError(`fetch failed for Bearer ${API_KEY}`));

      const result = await createClient().complete(createRequest());

      expect(result).toEqual({ ok: false, reason: "provider_error" });
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    });

    it("returns provider_error when a redirect is refused", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed: unexpected redirect"));

      expect(await createClient().complete(createRequest())).toEqual({ ok: false, reason: "provider_error" });
    });
  });

  describe("timeouts", () => {
    it("returns timeout when the request is aborted", async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation(async () => {
        controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
        throw controller.signal.reason;
      });

      expect(await createClient().complete(createRequest(controller.signal))).toEqual({
        ok: false,
        reason: "timeout",
      });
    });

    it("returns timeout when the body read is aborted", async () => {
      const controller = new AbortController();
      const stalledBody = new ReadableStream<Uint8Array>({
        pull() {
          controller.abort();
          throw new DOMException("This operation was aborted", "AbortError");
        },
      });
      fetchMock.mockResolvedValue(new Response(stalledBody));

      expect(await createClient().complete(createRequest(controller.signal))).toEqual({
        ok: false,
        reason: "timeout",
      });
    });
  });

  describe("API key handling", () => {
    it("does not expose the API key through serialization or inspection", () => {
      const client = createClient();

      expect(JSON.stringify(client)).not.toContain(API_KEY);
      expect(inspect(client, { depth: 5 })).not.toContain(API_KEY);
      expect(Object.values(client).map(String).join()).not.toContain(API_KEY);
    });
  });
});

describe("createCompletionClient", () => {
  it("creates the OpenRouter client for the openrouter provider", () => {
    const client = createCompletionClient({
      provider: "openrouter",
      apiKey: API_KEY,
      apiUrl: API_URL,
      model: MODEL,
    });

    expect(client).toBeInstanceOf(OpenRouterCompletionClient);
  });
});
