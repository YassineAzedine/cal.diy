import { BOOKING_ASSISTANT_LIMITS } from "@calcom/features/booking-assistant/lib/limits";
import { slotPreferenceSchema } from "@calcom/features/booking-assistant/lib/slotRequestSchema";
import { timeZoneSchema } from "@calcom/lib/dayjs/timeZone.schema";
import { z } from "zod";
import { getScheduleSchemaObject } from "./types";

/**
 * The Booker's getSchedule input plus the booker's free text. The date range comes from the parsed
 * request, and debug switches are not accepted. The timezone is required because the request is
 * interpreted in it.
 */
export const ZSuggestSlotsInputSchema = getScheduleSchemaObject
  .omit({
    startTime: true,
    endTime: true,
    debug: true,
    _enableTroubleshooter: true,
    _bypassCalendarBusyTimes: true,
    _silentCalendarFailures: true,
  })
  .extend({
    query: z.string().trim().min(1).max(BOOKING_ASSISTANT_LIMITS.maxQueryLength),
    timeZone: timeZoneSchema,
  })
  // Same normalisation and rule as getScheduleSchema, which can't be reused once fields are omitted.
  .transform((val) => ({ ...val, orgSlug: val.orgSlug || null }))
  .refine(
    (data) => !!data.eventTypeId || (!!data.usernameList && !!data.eventTypeSlug),
    "You need to either pass an eventTypeId OR an usernameList/eventTypeSlug combination"
  );

export type TSuggestSlotsInputSchema = z.infer<typeof ZSuggestSlotsInputSchema>;

const interpretationSchema = z.object({
  dateFrom: z.string(),
  dateTo: z.string(),
  timeWindows: z.array(z.object({ from: z.string(), to: z.string() })),
  weekdays: z.array(z.number().int()),
  preference: slotPreferenceSchema,
});

// Strips anything beyond these fields, so nothing internal can reach the booker by accident.
export const ZSuggestSlotsOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    slots: z.array(z.string()).min(1).max(BOOKING_ASSISTANT_LIMITS.maxSuggestions),
    interpretation: interpretationSchema,
  }),
  z.object({ status: z.literal("no_match"), interpretation: interpretationSchema }),
  z.object({ status: z.literal("not_understood") }),
  z.object({ status: z.literal("unavailable") }),
]);

export type TSuggestSlotsOutputSchema = z.infer<typeof ZSuggestSlotsOutputSchema>;
