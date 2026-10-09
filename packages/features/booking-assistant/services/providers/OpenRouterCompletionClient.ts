import { z } from "zod";
import { BOOKING_ASSISTANT_LIMITS } from "../../lib/limits";
import type {
  IStructuredCompletionClient,
  StructuredCompletionRequest,
  StructuredCompletionResult,
} from "../IStructuredCompletionClient";

export type OpenRouterCompletionClientOptions = {
  apiKey: string;
  apiUrl: string;
  model: string;
};

const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.union([z.string(), z.number()]).optional() }),
});

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1),
});

/**
 * Reads at most maxBytes of the body. Returns null when the body is larger, without
 * buffering the rest, so a misbehaving endpoint cannot make the server hold a huge response.
 */
const readBodyWithLimit = async (response: Response, maxBytes: number): Promise<string | null> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * OpenRouter's OpenAI-compatible chat completions endpoint. Results carry only safe-to-log
 * fields: never the API key, the request, or the provider's error message, which can echo the input.
 */
export class OpenRouterCompletionClient implements IStructuredCompletionClient {
  // The key lives only in this closure, not as a property, so logging or serializing the client can't leak it.
  private readonly authorizationHeader: () => string;
  private readonly apiUrl: string;
  private readonly model: string;

  constructor({ apiKey, apiUrl, model }: OpenRouterCompletionClientOptions) {
    this.authorizationHeader = () => `Bearer ${apiKey}`;
    this.apiUrl = apiUrl;
    this.model = model;
  }

  async complete(request: StructuredCompletionRequest): Promise<StructuredCompletionResult> {
    let response: Response;
    try {
      response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          Authorization: this.authorizationHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userMessage },
          ],
          temperature: 0,
          max_tokens: request.maxOutputTokens,
          response_format: {
            type: "json_schema",
            json_schema: { name: request.schemaName, strict: true, schema: request.jsonSchema },
          },
          provider: { require_parameters: true, data_collection: "deny" },
        }),
        // A redirect would forward the Authorization header to a host we did not choose.
        redirect: "error",
        signal: request.signal,
      });
    } catch {
      return { ok: false, reason: request.signal.aborted ? "timeout" : "provider_error" };
    }

    let body: string | null;
    try {
      body = await readBodyWithLimit(response, BOOKING_ASSISTANT_LIMITS.maxResponseBytes);
    } catch {
      return { ok: false, reason: request.signal.aborted ? "timeout" : "provider_error" };
    }
    if (body === null) {
      // An oversized error page is still an outage, not an unusable answer.
      return {
        ok: false,
        reason: response.ok ? "invalid_response" : "provider_error",
        httpStatus: response.status,
      };
    }

    const json = parseJson(body);
    // OpenRouter can report an error in the body even with a 200 status.
    const errorEnvelope = errorEnvelopeSchema.safeParse(json);
    if (!response.ok || errorEnvelope.success) {
      return {
        ok: false,
        reason: "provider_error",
        httpStatus: response.status,
        providerErrorCode: errorEnvelope.success ? errorEnvelope.data.error.code : undefined,
      };
    }

    const completion = completionSchema.safeParse(json);
    const content = completion.success ? completion.data.choices[0].message.content : null;
    if (!content) return { ok: false, reason: "invalid_response", httpStatus: response.status };

    return { ok: true, content };
  }
}
