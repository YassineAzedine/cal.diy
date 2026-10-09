import type { SlotRequest } from "../lib/slotRequestSchema";

export type ParseSlotRequestInput = {
  query: string;
  // The booker's current date and IANA timezone; the parsed dates and times are expressed in them.
  today: string;
  timeZone: string;
  signal?: AbortSignal;
};

export type SlotRequestParseFailureReason = "timeout" | "provider_error" | "invalid_output";

// A request the model did not understand is a successful parse with `understood: false`.
export type ParseSlotRequestResult =
  | { status: "ok"; request: SlotRequest }
  | { status: "failed"; reason: SlotRequestParseFailureReason };

/**
 * Turns the booker's free text into a validated SlotRequest. Resolves rather than throws on
 * provider or model failures so the caller can fall back to the normal Booker.
 */
export interface ISlotRequestParser {
  parse(input: ParseSlotRequestInput): Promise<ParseSlotRequestResult>;
}
