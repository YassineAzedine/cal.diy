import type { IGetAvailableSlots } from "@calcom/features/bookings/Booker/hooks/useAvailableTimeSlots";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { GetScheduleOptions } from "@calcom/trpc/server/routers/viewer/slots/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlotRequest } from "../lib/slotRequestSchema";
import type { AssistantScheduleInput, IAvailableSlotsReader } from "./BookingAssistantService";
import { BookingAssistantService } from "./BookingAssistantService";
import type { ISlotRequestParser, ParseSlotRequestResult } from "./ISlotRequestParser";

const scheduleInput: AssistantScheduleInput = {
  eventTypeId: 42,
  eventTypeSlug: "30min",
  usernameList: ["pro"],
  isTeamEvent: false,
  orgSlug: null,
  rescheduleUid: null,
  timeZone: "Europe/Paris",
};

const tuesdayAfternoon: SlotRequest = {
  understood: true,
  dateFrom: "2026-10-13",
  dateTo: "2026-10-13",
  timeWindows: [{ from: "12:00", to: "17:00" }],
  weekdays: [],
  preference: "earliest",
};

// Paris is UTC+2 in October 2026.
const engineSlots: IGetAvailableSlots["slots"] = {
  "2026-10-13": [
    { time: "2026-10-13T08:00:00.000Z" }, // 10:00, before the window
    { time: "2026-10-13T10:00:00.000Z" }, // 12:00
    { time: "2026-10-13T11:00:00.000Z", away: true }, // out of office, never offered
    { time: "2026-10-13T12:30:00.000Z" }, // 14:30
    { time: "2026-10-13T15:00:00.000Z" }, // 17:00, the window end is exclusive
  ],
};

const setup = ({
  parseResult = { status: "ok", request: tuesdayAfternoon },
  slots = engineSlots,
}: {
  parseResult?: ParseSlotRequestResult;
  slots?: IGetAvailableSlots["slots"];
} = {}) => {
  const slotRequestParser = { parse: vi.fn<ISlotRequestParser["parse"]>().mockResolvedValue(parseResult) };
  const availableSlots = {
    getAvailableSlots: vi.fn<IAvailableSlotsReader["getAvailableSlots"]>().mockResolvedValue({ slots }),
  };
  const service = new BookingAssistantService({ slotRequestParser, availableSlots });
  const engineCall = (): GetScheduleOptions => availableSlots.getAvailableSlots.mock.calls[0][0];
  return { service, slotRequestParser, availableSlots, engineCall };
};

const parsed = (request: Partial<Extract<SlotRequest, { understood: true }>>): ParseSlotRequestResult => ({
  status: "ok",
  request: { ...tuesdayAfternoon, ...request } as SlotRequest,
});

describe("BookingAssistantService", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("results", () => {
    it("returns the matching engine slots with the interpretation", async () => {
      const { service } = setup();

      expect(await service.suggestSlots({ query: "tuesday afternoon", scheduleInput })).toEqual({
        status: "ok",
        slots: ["2026-10-13T10:00:00.000Z", "2026-10-13T12:30:00.000Z"],
        interpretation: {
          dateFrom: "2026-10-13",
          dateTo: "2026-10-13",
          timeWindows: [{ from: "12:00", to: "17:00" }],
          weekdays: [],
          preference: "earliest",
        },
      });
    });

    it("only ever returns slot strings the engine provided", async () => {
      const { service } = setup({ parseResult: parsed({ timeWindows: [] }) });
      const engineTimes = new Set(Object.values(engineSlots).flatMap((day) => day.map((slot) => slot.time)));

      const result = await service.suggestSlots({ query: "tuesday", scheduleInput });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.slots.length).toBeGreaterThan(0);
      expect(result.slots.length).toBeLessThanOrEqual(3);
      for (const slot of result.slots) expect(engineTimes.has(slot)).toBe(true);
    });

    it("returns no_match with the interpretation when no engine slot passes the filter", async () => {
      const { service } = setup({ parseResult: parsed({ timeWindows: [{ from: "18:00", to: "20:00" }] }) });

      expect(await service.suggestSlots({ query: "tuesday evening", scheduleInput })).toEqual({
        status: "no_match",
        interpretation: expect.objectContaining({ dateFrom: "2026-10-13", dateTo: "2026-10-13" }),
      });
    });

    it("returns no_match when the engine has no slots at all", async () => {
      const { service } = setup({ slots: {} });

      expect((await service.suggestSlots({ query: "tuesday afternoon", scheduleInput })).status).toBe(
        "no_match"
      );
    });

    it("reports the clamped range, not the requested one, as the interpretation", async () => {
      const { service } = setup({ parseResult: parsed({ dateFrom: "2026-10-01", dateTo: "2026-10-13" }) });

      const result = await service.suggestSlots({ query: "this week or next", scheduleInput });

      expect(result).toMatchObject({ interpretation: { dateFrom: "2026-10-09", dateTo: "2026-10-13" } });
    });
  });

  describe("short-circuits before the slot engine", () => {
    it.each([
      "timeout",
      "provider_error",
      "invalid_output",
    ] as const)("returns unavailable when the parser fails with %s", async (reason) => {
      const { service, availableSlots } = setup({ parseResult: { status: "failed", reason } });

      expect(await service.suggestSlots({ query: "tuesday", scheduleInput })).toEqual({
        status: "unavailable",
      });
      expect(availableSlots.getAvailableSlots).not.toHaveBeenCalled();
    });

    it("returns not_understood without computing slots", async () => {
      const { service, availableSlots } = setup({
        parseResult: { status: "ok", request: { understood: false } },
      });

      expect(await service.suggestSlots({ query: "what is the weather", scheduleInput })).toEqual({
        status: "not_understood",
      });
      expect(availableSlots.getAvailableSlots).not.toHaveBeenCalled();
    });

    it("returns no_match with the requested range when it is entirely in the past", async () => {
      const { service, availableSlots } = setup({
        parseResult: parsed({ dateFrom: "2026-10-01", dateTo: "2026-10-05" }),
      });

      expect(await service.suggestSlots({ query: "last week", scheduleInput })).toEqual({
        status: "no_match",
        interpretation: expect.objectContaining({ dateFrom: "2026-10-01", dateTo: "2026-10-05" }),
      });
      expect(availableSlots.getAvailableSlots).not.toHaveBeenCalled();
    });

    it("returns unavailable without computing slots when the booker cancelled during parsing", async () => {
      const controller = new AbortController();
      const { service, slotRequestParser, availableSlots } = setup();
      slotRequestParser.parse.mockImplementation(async () => {
        controller.abort();
        return { status: "ok", request: tuesdayAfternoon };
      });

      expect(
        await service.suggestSlots({ query: "tuesday afternoon", scheduleInput, signal: controller.signal })
      ).toEqual({ status: "unavailable" });
      expect(availableSlots.getAvailableSlots).not.toHaveBeenCalled();
    });

    it("returns no_match when the range starts beyond 90 days ahead", async () => {
      const { service, availableSlots } = setup({
        parseResult: parsed({ dateFrom: "2027-03-01", dateTo: "2027-03-05" }),
      });

      expect((await service.suggestSlots({ query: "march", scheduleInput })).status).toBe("no_match");
      expect(availableSlots.getAvailableSlots).not.toHaveBeenCalled();
    });
  });

  describe("parser input", () => {
    it("passes the query, the booker's today and timezone, and the cancellation signal", async () => {
      const { service, slotRequestParser } = setup();
      const signal = new AbortController().signal;

      await service.suggestSlots({ query: "tuesday afternoon", scheduleInput, signal });

      expect(slotRequestParser.parse).toHaveBeenCalledWith({
        query: "tuesday afternoon",
        today: "2026-10-09",
        timeZone: "Europe/Paris",
        signal,
      });
    });

    it("uses the booker's date, not the UTC date, as today", async () => {
      // 23:30 UTC is already 05:00 the next day in Kolkata (UTC+5:30).
      vi.setSystemTime(new Date("2026-10-09T23:30:00.000Z"));
      const { service, slotRequestParser } = setup();

      await service.suggestSlots({
        query: "tomorrow",
        scheduleInput: { ...scheduleInput, timeZone: "Asia/Kolkata" },
      });

      expect(slotRequestParser.parse.mock.calls[0][0].today).toBe("2026-10-10");
    });

    it("throws a bad request error for an invalid timezone without calling the parser", async () => {
      const { service, slotRequestParser } = setup();

      await expect(
        service.suggestSlots({
          query: "tuesday",
          scheduleInput: { ...scheduleInput, timeZone: "Mars/Olympus" },
        })
      ).rejects.toThrow(ErrorWithCode);
      expect(slotRequestParser.parse).not.toHaveBeenCalled();
    });
  });

  describe("slot engine input", () => {
    it("passes the booker's schedule input and context through, replacing only the date range", async () => {
      const { service, engineCall } = setup();
      const ctx = { req: undefined };

      await service.suggestSlots({ query: "tuesday afternoon", scheduleInput, ctx });

      expect(engineCall().ctx).toBe(ctx);
      expect(engineCall().input).toEqual({
        ...scheduleInput,
        startTime: "2026-10-12T22:00:00.000Z",
        endTime: "2026-10-13T21:59:59.999Z",
        debug: false,
        _enableTroubleshooter: false,
        _bypassCalendarBusyTimes: false,
        _silentCalendarFailures: false,
      });
    });

    it("overrides a date range and debug switches smuggled into the schedule input", async () => {
      const { service, engineCall } = setup();
      const smuggledInput = {
        ...scheduleInput,
        startTime: "2020-01-01T00:00:00.000Z",
        endTime: "2030-01-01T00:00:00.000Z",
        debug: true,
        _enableTroubleshooter: true,
        _bypassCalendarBusyTimes: true,
        _silentCalendarFailures: true,
      };

      await service.suggestSlots({ query: "tuesday afternoon", scheduleInput: smuggledInput });

      expect(engineCall().input).toMatchObject({
        startTime: "2026-10-12T22:00:00.000Z",
        endTime: "2026-10-13T21:59:59.999Z",
        debug: false,
        _enableTroubleshooter: false,
        _bypassCalendarBusyTimes: false,
        _silentCalendarFailures: false,
      });
    });

    it("covers a 23-hour daylight-saving day exactly", async () => {
      // Paris moves from UTC+1 to UTC+2 on 2027-03-28.
      vi.setSystemTime(new Date("2027-03-20T10:00:00.000Z"));
      const { service, engineCall } = setup({
        parseResult: parsed({ dateFrom: "2027-03-28", dateTo: "2027-03-28" }),
      });

      await service.suggestSlots({ query: "sunday the 28th", scheduleInput });

      expect(engineCall().input).toMatchObject({
        startTime: "2027-03-27T23:00:00.000Z",
        endTime: "2027-03-28T21:59:59.999Z",
      });
    });

    it.each([
      // Chile skips from 00:00 to 01:00 on 2026-09-06, so that day starts at 01:00 local (UTC-3)...
      ["starts", "2026-09-06", "2026-09-06T04:00:00.000Z", "2026-09-07T02:59:59.999Z"],
      // ...and the day before ends just before it, making it 23 hours long at UTC-4.
      ["ends", "2026-09-05", "2026-09-05T04:00:00.000Z", "2026-09-06T03:59:59.999Z"],
    ])("handles a day that %s at a missing midnight", async (_, date, startTime, endTime) => {
      vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
      const { service, engineCall } = setup({ parseResult: parsed({ dateFrom: date, dateTo: date }) });

      await service.suggestSlots({
        query: "that day",
        scheduleInput: { ...scheduleInput, timeZone: "America/Santiago" },
      });

      expect(engineCall().input).toMatchObject({ startTime, endTime });
    });

    it("handles timezones with a half-hour offset", async () => {
      vi.setSystemTime(new Date("2026-10-09T23:30:00.000Z"));
      const { service, engineCall } = setup({
        parseResult: parsed({ dateFrom: "2026-10-10", dateTo: "2026-10-10" }),
      });

      await service.suggestSlots({
        query: "today",
        scheduleInput: { ...scheduleInput, timeZone: "Asia/Kolkata" },
      });

      expect(engineCall().input).toMatchObject({
        startTime: "2026-10-09T18:30:00.000Z",
        endTime: "2026-10-10T18:29:59.999Z",
      });
    });

    it("fetches the next morning when a window runs past midnight", async () => {
      const { service, engineCall } = setup({
        parseResult: parsed({
          dateFrom: "2026-10-16",
          dateTo: "2026-10-16",
          timeWindows: [{ from: "22:00", to: "01:00" }],
        }),
      });

      await service.suggestSlots({ query: "friday night", scheduleInput });

      expect(engineCall().input).toMatchObject({
        startTime: "2026-10-15T22:00:00.000Z",
        endTime: "2026-10-17T21:59:59.999Z",
      });
    });

    it("counts a slot after midnight towards the requested evening", async () => {
      const { service } = setup({
        parseResult: parsed({
          dateFrom: "2026-10-16",
          dateTo: "2026-10-16",
          timeWindows: [{ from: "22:00", to: "01:00" }],
        }),
        // 00:30 on Saturday in Paris.
        slots: { "2026-10-17": [{ time: "2026-10-16T22:30:00.000Z" }] },
      });

      expect(await service.suggestSlots({ query: "friday night", scheduleInput })).toMatchObject({
        status: "ok",
        slots: ["2026-10-16T22:30:00.000Z"],
      });
    });

    it("does not fetch an extra day for a window ending exactly at midnight", async () => {
      const { service, engineCall } = setup({
        parseResult: parsed({
          dateFrom: "2026-10-16",
          dateTo: "2026-10-16",
          timeWindows: [{ from: "15:00", to: "00:00" }],
        }),
      });

      await service.suggestSlots({ query: "friday after 3pm", scheduleInput });

      expect(engineCall().input.endTime).toBe("2026-10-16T21:59:59.999Z");
    });
  });

  describe("slot engine errors", () => {
    it("passes engine errors through unchanged", async () => {
      const { service, availableSlots } = setup();
      const engineError = ErrorWithCode.Factory.NotFound("Event type not found");
      availableSlots.getAvailableSlots.mockRejectedValue(engineError);

      await expect(service.suggestSlots({ query: "tuesday afternoon", scheduleInput })).rejects.toBe(
        engineError
      );
    });
  });
});
