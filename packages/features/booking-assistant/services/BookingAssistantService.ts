import dayjs from "@calcom/dayjs";
import type { IGetAvailableSlots } from "@calcom/features/bookings/Booker/hooks/useAvailableTimeSlots";
import { ErrorWithCode } from "@calcom/lib/errors";
import type {
  ContextForGetSchedule,
  GetScheduleOptions,
  TGetScheduleInputSchema,
} from "@calcom/trpc/server/routers/viewer/slots/types";
import { addDays } from "../lib/calendarDate";
import { filterSlots } from "../lib/filterSlots";
import type { DateRange, UnderstoodSlotRequest } from "../lib/slotRequestSchema";
import { clampDateRange } from "../lib/slotRequestSchema";
import type { ISlotRequestParser } from "./ISlotRequestParser";

/** The part of AvailableSlotsService the assistant needs; the existing service satisfies it as is. */
export interface IAvailableSlotsReader {
  getAvailableSlots(options: GetScheduleOptions): Promise<IGetAvailableSlots>;
}

export interface IBookingAssistantServiceDeps {
  slotRequestParser: ISlotRequestParser;
  availableSlots: IAvailableSlotsReader;
}

type ServerControlledScheduleFields =
  | "startTime"
  | "endTime"
  | "debug"
  | "_enableTroubleshooter"
  | "_bypassCalendarBusyTimes"
  | "_silentCalendarFailures";

// The Booker's getSchedule input. The date range comes from the parsed request, and the booker's
// timezone is required because every date and time in the request is expressed in it.
export type AssistantScheduleInput = Omit<TGetScheduleInputSchema, ServerControlledScheduleFields> & {
  timeZone: string;
};

export type SuggestSlotsInput = {
  query: string;
  scheduleInput: AssistantScheduleInput;
  ctx?: ContextForGetSchedule;
  signal?: AbortSignal;
};

export type SlotRequestInterpretation = Pick<
  UnderstoodSlotRequest,
  "dateFrom" | "dateTo" | "timeWindows" | "weekdays" | "preference"
>;

export type SuggestSlotsResult =
  | { status: "ok"; slots: string[]; interpretation: SlotRequestInterpretation }
  | { status: "no_match"; interpretation: SlotRequestInterpretation }
  | { status: "not_understood" }
  | { status: "unavailable" };

const getTodayInTimeZone = (timeZone: string, now: Date) => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
  } catch {
    throw ErrorWithCode.Factory.BadRequest("Unable to suggest slots: invalid timezone");
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};

/**
 * Converts the booker's local calendar range into the UTC instants getSchedule expects. The end is
 * one millisecond before the next local midnight, which stays correct on 23- and 25-hour DST days.
 */
const toScheduleWindow = (range: DateRange, timeZone: string, includeNextMorning: boolean) => {
  const lastDate = includeNextMorning ? addDays(range.dateTo, 1) : range.dateTo;
  return {
    startTime: dayjs.tz(range.dateFrom, timeZone).toISOString(),
    endTime: new Date(dayjs.tz(addDays(lastDate, 1), timeZone).valueOf() - 1).toISOString(),
  };
};

/**
 * Turns a booker's free-text request into at most a few real slots. The LLM only produces a filter;
 * slots always come from the existing slot engine, called once, so every suggestion is bookable.
 */
export class BookingAssistantService {
  constructor(private readonly deps: IBookingAssistantServiceDeps) {}

  async suggestSlots({ query, scheduleInput, ctx, signal }: SuggestSlotsInput): Promise<SuggestSlotsResult> {
    const { timeZone } = scheduleInput;
    const today = getTodayInTimeZone(timeZone, new Date());

    // Parse first: a failed or not-understood request never costs a slot computation.
    const parsed = await this.deps.slotRequestParser.parse({ query, today, timeZone, signal });
    if (parsed.status === "failed") return { status: "unavailable" };
    const { request } = parsed;
    if (!request.understood) return { status: "not_understood" };

    const requested: SlotRequestInterpretation = {
      dateFrom: request.dateFrom,
      dateTo: request.dateTo,
      timeWindows: request.timeWindows,
      weekdays: request.weekdays,
      preference: request.preference,
    };
    const range = clampDateRange(requested, today);
    if (!range) return { status: "no_match", interpretation: requested };

    // The booker may have left while the model was answering; don't compute slots nobody will see.
    if (signal?.aborted) return { status: "unavailable" };

    const interpretation = { ...requested, ...range };
    // After-midnight slots of a window like 22:00-01:00 fall on the day after dateTo but count towards it.
    // A window ending exactly at 00:00 has no after-midnight part, so it needs no extra day.
    const includeNextMorning = interpretation.timeWindows.some(
      (window) => window.to < window.from && window.to !== "00:00"
    );

    const schedule = await this.deps.availableSlots.getAvailableSlots({
      ctx,
      input: {
        ...scheduleInput,
        ...toScheduleWindow(range, timeZone, includeNextMorning),
        // Debug and troubleshooting switches are never driven by the assistant.
        debug: false,
        _enableTroubleshooter: false,
        _bypassCalendarBusyTimes: false,
        _silentCalendarFailures: false,
      },
    });

    const slots = filterSlots({ slots: schedule.slots, filter: interpretation, timeZone });
    if (!slots.length) return { status: "no_match", interpretation };
    return { status: "ok", slots, interpretation };
  }
}
