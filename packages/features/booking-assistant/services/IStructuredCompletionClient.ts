export type StructuredCompletionRequest = {
  systemPrompt: string;
  userMessage: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type StructuredCompletionFailureReason = "timeout" | "provider_error" | "invalid_response";

export type StructuredCompletionResult =
  | { ok: true; content: string }
  | {
      ok: false;
      reason: StructuredCompletionFailureReason;
      // Safe to log. Never the provider's raw message, which can echo the booker's text.
      httpStatus?: number;
      providerErrorCode?: string | number;
    };

/**
 * The only provider-specific piece of the booking assistant: one request with a system prompt,
 * a user message and a JSON Schema, answered with the model's raw text. The schema is a hint to
 * the provider; callers must still validate the content themselves.
 *
 * Implementations must resolve rather than throw on provider failures, and must never put the
 * API key or the provider's raw error message in the result.
 */
export interface IStructuredCompletionClient {
  complete(request: StructuredCompletionRequest): Promise<StructuredCompletionResult>;
}
