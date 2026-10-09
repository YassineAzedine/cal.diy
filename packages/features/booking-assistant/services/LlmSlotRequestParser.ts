import logger from "@calcom/lib/logger";
import { BOOKING_ASSISTANT_LIMITS } from "../lib/limits";
import {
  buildSlotRequestUserMessage,
  SLOT_REQUEST_SCHEMA_NAME,
  SLOT_REQUEST_SYSTEM_PROMPT,
  sanitizeBookerQuery,
  slotRequestJsonSchema,
} from "../lib/slotRequestPrompt";
import { slotRequestSchema } from "../lib/slotRequestSchema";
import type {
  ISlotRequestParser,
  ParseSlotRequestInput,
  ParseSlotRequestResult,
  SlotRequestParseFailureReason,
} from "./ISlotRequestParser";
import type { IStructuredCompletionClient, StructuredCompletionResult } from "./IStructuredCompletionClient";

const log = logger.getSubLogger({ prefix: ["booking-assistant"] });

const CODE_FENCE = "```";

export interface ILlmSlotRequestParserDeps {
  client: IStructuredCompletionClient;
}

/**
 * Some models wrap JSON in a markdown fence even when asked not to; anything else is rejected.
 * Plain string operations on purpose: a regex for this backtracks catastrophically on model
 * output like "```" followed by thousands of spaces, blocking the event loop for minutes.
 */
const stripCodeFence = (content: string) => {
  const trimmed = content.trim();
  const isFenced =
    trimmed.length >= CODE_FENCE.length * 2 && trimmed.startsWith(CODE_FENCE) && trimmed.endsWith(CODE_FENCE);
  if (!isFenced) return trimmed;

  const inner = trimmed.slice(CODE_FENCE.length, -CODE_FENCE.length);
  return (inner.slice(0, 4).toLowerCase() === "json" ? inner.slice(4) : inner).trim();
};

const parseModelJson = (content: string): unknown => {
  const unfenced = stripCodeFence(content);
  try {
    return JSON.parse(unfenced);
  } catch {
    return undefined;
  }
};

const failed = (reason: SlotRequestParseFailureReason, details: Record<string, unknown> = {}) => {
  // Never log the booker's text or the model's answer: both can contain personal data.
  log.warn("Booking assistant could not parse the request", { reason, ...details });
  return { status: "failed", reason } as const;
};

export class LlmSlotRequestParser implements ISlotRequestParser {
  constructor(private readonly deps: ILlmSlotRequestParserDeps) {}

  async parse({ query, today, timeZone, signal }: ParseSlotRequestInput): Promise<ParseSlotRequestResult> {
    const sanitizedQuery = sanitizeBookerQuery(query);
    if (!sanitizedQuery) return { status: "ok", request: { understood: false } };

    const userMessage = buildSlotRequestUserMessage({ query: sanitizedQuery, today, timeZone });
    const timeoutSignal = AbortSignal.timeout(BOOKING_ASSISTANT_LIMITS.requestTimeoutMs);
    const startedAt = Date.now();

    let result: StructuredCompletionResult;
    try {
      result = await this.deps.client.complete({
        systemPrompt: SLOT_REQUEST_SYSTEM_PROMPT,
        userMessage,
        schemaName: SLOT_REQUEST_SCHEMA_NAME,
        jsonSchema: slotRequestJsonSchema,
        maxOutputTokens: BOOKING_ASSISTANT_LIMITS.maxOutputTokens,
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
    } catch {
      // Clients must not throw, but a buggy one must not break the Booker either.
      return failed("provider_error", { durationMs: Date.now() - startedAt });
    }

    if (!result.ok) {
      const { reason, httpStatus, providerErrorCode } = result;
      return failed(reason === "invalid_response" ? "invalid_output" : reason, {
        durationMs: Date.now() - startedAt,
        httpStatus,
        providerErrorCode,
      });
    }

    if (result.content.length > BOOKING_ASSISTANT_LIMITS.maxResponseBytes) {
      return failed("invalid_output", { durationMs: Date.now() - startedAt, cause: "oversized_content" });
    }

    const json = parseModelJson(result.content);
    if (json === undefined) {
      return failed("invalid_output", { durationMs: Date.now() - startedAt, cause: "malformed_json" });
    }

    const validation = slotRequestSchema.safeParse(json);
    if (!validation.success) {
      return failed("invalid_output", { durationMs: Date.now() - startedAt, cause: "schema_mismatch" });
    }

    return { status: "ok", request: validation.data };
  }
}
