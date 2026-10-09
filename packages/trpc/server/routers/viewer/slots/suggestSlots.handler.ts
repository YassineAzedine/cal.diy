import type { SuggestSlotsResult } from "@calcom/features/booking-assistant/services/BookingAssistantService";
import { getBookingAssistantService } from "@calcom/features/di/containers/BookingAssistantService";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import { HttpError } from "@calcom/lib/http-error";
import { piiHasher } from "@calcom/lib/server/PiiHasher";
import { TRPCError } from "@trpc/server";
import type { TSuggestSlotsInputSchema } from "./suggestSlots.schema";
import type { ContextForGetSchedule } from "./types";

type SuggestSlotsOptions = {
  ctx: ContextForGetSchedule & { sourceIp?: string };
  input: TSuggestSlotsInputSchema;
};

/**
 * This tRPC version passes no AbortSignal to resolvers, so a request the booker abandons still
 * runs; the parser's own timeout bounds how long the LLM call can take.
 */
export const suggestSlotsHandler = async ({
  ctx,
  input,
}: SuggestSlotsOptions): Promise<SuggestSlotsResult> => {
  const service = getBookingAssistantService();
  // A bare NOT_FOUND, so a disabled or misconfigured instance reveals nothing about its configuration.
  if (!service) throw new TRPCError({ code: "NOT_FOUND" });

  try {
    await checkRateLimitAndThrowError({
      rateLimitingType: "ai",
      // Hashed so the raw IP is never sent to the rate limiter. Requests without an IP share one
      // bucket, which fails closed rather than leaving them unlimited.
      identifier: `bookingAssistant:${piiHasher.hash(ctx.sourceIp ?? "unknown")}`,
    });
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 429) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: error.message });
    }
    throw error;
  }

  const { query, ...scheduleInput } = input;
  return service.suggestSlots({ query, scheduleInput, ctx });
};
