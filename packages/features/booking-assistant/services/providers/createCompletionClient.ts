import type { BookingAssistantConfig } from "../../lib/config";
import type { IStructuredCompletionClient } from "../IStructuredCompletionClient";
import { OpenRouterCompletionClient } from "./OpenRouterCompletionClient";

export function createCompletionClient(config: BookingAssistantConfig): IStructuredCompletionClient {
  switch (config.provider) {
    case "openrouter":
      return new OpenRouterCompletionClient({
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
        model: config.model,
      });
  }
}
