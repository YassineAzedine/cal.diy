import type { SuggestSlotsResult } from "@calcom/features/booking-assistant/services/BookingAssistantService";
import { ErrorWithCode } from "@calcom/lib/errors";
import { HttpError } from "@calcom/lib/http-error";
import { piiHasher } from "@calcom/lib/server/PiiHasher";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { suggestSlotsHandler } from "./suggestSlots.handler";
import type { TSuggestSlotsInputSchema } from "./suggestSlots.schema";
import { ZSuggestSlotsInputSchema, ZSuggestSlotsOutputSchema } from "./suggestSlots.schema";

const { mockGetBookingAssistantService, mockCheckRateLimit, mockSuggestSlots } = vi.hoisted(() => ({
  mockGetBookingAssistantService: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockSuggestSlots: vi.fn(),
}));

vi.mock("@calcom/features/di/containers/BookingAssistantService", () => ({
  getBookingAssistantService: mockGetBookingAssistantService,
}));

vi.mock("@calcom/lib/checkRateLimitAndThrowError", () => ({
  checkRateLimitAndThrowError: mockCheckRateLimit,
}));

const SOURCE_IP = "203.0.113.7";

const validInput = {
  query: "next tuesday afternoon",
  eventTypeId: 42,
  eventTypeSlug: "30min",
  usernameList: ["pro"],
  isTeamEvent: false,
  timeZone: "Europe/Paris",
};

const parseInput = (overrides: Record<string, unknown> = {}): TSuggestSlotsInputSchema =>
  ZSuggestSlotsInputSchema.parse({ ...validInput, ...overrides });

const interpretation = {
  dateFrom: "2026-10-13",
  dateTo: "2026-10-13",
  timeWindows: [{ from: "12:00", to: "17:00" }],
  weekdays: [],
  preference: "earliest" as const,
};

describe("ZSuggestSlotsInputSchema", () => {
  it("accepts the Booker's schedule input with a query", () => {
    expect(parseInput()).toMatchObject({ ...validInput, orgSlug: null });
  });

  it("trims the query", () => {
    expect(parseInput({ query: "  tuesday  " }).query).toBe("tuesday");
  });

  it.each([
    ["an empty query", { query: "" }],
    ["a whitespace-only query", { query: "   " }],
    ["a query over 200 characters", { query: "a".repeat(201) }],
    ["a missing timezone", { timeZone: undefined }],
    ["an invalid timezone", { timeZone: "Mars/Olympus" }],
    ["no event identification", { eventTypeId: undefined, usernameList: undefined }],
    ["a username list without an event slug", { eventTypeId: undefined, eventTypeSlug: undefined }],
  ])("rejects %s", (_, overrides) => {
    expect(ZSuggestSlotsInputSchema.safeParse({ ...validInput, ...overrides }).success).toBe(false);
  });

  it("accepts a username list with an event slug instead of an event type id", () => {
    expect(ZSuggestSlotsInputSchema.safeParse({ ...validInput, eventTypeId: undefined }).success).toBe(true);
  });

  it("normalises the +00:00 timezone to UTC, like getSchedule", () => {
    expect(parseInput({ timeZone: "+00:00" }).timeZone).toBe("UTC");
  });

  it("drops the date range and debug switches if a client sends them", () => {
    const parsed = parseInput({
      startTime: "2020-01-01T00:00:00.000Z",
      endTime: "2030-01-01T00:00:00.000Z",
      debug: true,
      _enableTroubleshooter: true,
      _bypassCalendarBusyTimes: true,
      _silentCalendarFailures: true,
    });

    for (const key of [
      "startTime",
      "endTime",
      "debug",
      "_enableTroubleshooter",
      "_bypassCalendarBusyTimes",
      "_silentCalendarFailures",
    ]) {
      expect(parsed).not.toHaveProperty(key);
    }
  });
});

describe("ZSuggestSlotsOutputSchema", () => {
  it.each<SuggestSlotsResult>([
    { status: "ok", slots: ["2026-10-13T10:00:00.000Z"], interpretation },
    { status: "no_match", interpretation },
    { status: "not_understood" },
    { status: "unavailable" },
  ])("accepts the $status result", (result) => {
    expect(ZSuggestSlotsOutputSchema.parse(result)).toEqual(result);
  });

  it("rejects more than three slots", () => {
    const slots = ["10", "11", "12", "13"].map((hour) => `2026-10-13T${hour}:00:00.000Z`);

    expect(ZSuggestSlotsOutputSchema.safeParse({ status: "ok", slots, interpretation }).success).toBe(false);
  });

  it("rejects an ok result without slots", () => {
    expect(ZSuggestSlotsOutputSchema.safeParse({ status: "ok", slots: [], interpretation }).success).toBe(
      false
    );
  });

  it("strips fields that are not part of the contract", () => {
    const parsed = ZSuggestSlotsOutputSchema.parse({
      status: "unavailable",
      troubleshooter: { routedHosts: [{ userId: 1 }] },
    });

    expect(parsed).toEqual({ status: "unavailable" });
  });
});

describe("suggestSlotsHandler", () => {
  const ctx = { req: undefined, sourceIp: SOURCE_IP };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBookingAssistantService.mockReturnValue({ suggestSlots: mockSuggestSlots });
    mockCheckRateLimit.mockResolvedValue({ success: true });
    mockSuggestSlots.mockResolvedValue({ status: "not_understood" });
  });

  it("responds NOT_FOUND without rate limiting or calling the service when the feature is off", async () => {
    mockGetBookingAssistantService.mockReturnValue(null);

    const error = await suggestSlotsHandler({ ctx, input: parseInput() }).catch((e) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect(error.code).toBe("NOT_FOUND");
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockSuggestSlots).not.toHaveBeenCalled();
  });

  it("rate limits with the AI bucket keyed by the hashed IP, never the raw IP", async () => {
    await suggestSlotsHandler({ ctx, input: parseInput() });

    expect(mockCheckRateLimit).toHaveBeenCalledWith({
      rateLimitingType: "ai",
      identifier: `bookingAssistant:${piiHasher.hash(SOURCE_IP)}`,
    });
    expect(JSON.stringify(mockCheckRateLimit.mock.calls)).not.toContain(SOURCE_IP);
  });

  it("puts requests without an IP in one shared bucket", async () => {
    await suggestSlotsHandler({ ctx: { req: undefined }, input: parseInput() });

    expect(mockCheckRateLimit).toHaveBeenCalledWith({
      rateLimitingType: "ai",
      identifier: `bookingAssistant:${piiHasher.hash("unknown")}`,
    });
  });

  it("responds TOO_MANY_REQUESTS without calling the service when rate limited", async () => {
    mockCheckRateLimit.mockRejectedValue(
      new HttpError({ statusCode: 429, message: "Rate limit exceeded. Try again in 3600 seconds." })
    );

    const error = await suggestSlotsHandler({ ctx, input: parseInput() }).catch((e) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect(error.code).toBe("TOO_MANY_REQUESTS");
    expect(error.message).toBe("Rate limit exceeded. Try again in 3600 seconds.");
    expect(mockSuggestSlots).not.toHaveBeenCalled();
  });

  it("passes other rate limiter errors through", async () => {
    const limiterError = new Error("limiter misconfigured");
    mockCheckRateLimit.mockRejectedValue(limiterError);

    await expect(suggestSlotsHandler({ ctx, input: parseInput() })).rejects.toBe(limiterError);
    expect(mockSuggestSlots).not.toHaveBeenCalled();
  });

  it("passes the query separately from the schedule input, with the request context", async () => {
    const input = parseInput();

    await suggestSlotsHandler({ ctx, input });

    const { query, ...scheduleInput } = input;
    expect(mockSuggestSlots).toHaveBeenCalledWith({ query, scheduleInput, ctx });
    expect(mockSuggestSlots.mock.calls[0][0].scheduleInput).not.toHaveProperty("query");
  });

  it.each<SuggestSlotsResult>([
    { status: "ok", slots: ["2026-10-13T10:00:00.000Z"], interpretation },
    { status: "no_match", interpretation },
    { status: "not_understood" },
    { status: "unavailable" },
  ])("returns the $status result unchanged", async (result) => {
    mockSuggestSlots.mockResolvedValue(result);

    expect(await suggestSlotsHandler({ ctx, input: parseInput() })).toEqual(result);
  });

  it("passes service and slot engine errors through for the error middleware to convert", async () => {
    const engineError = ErrorWithCode.Factory.NotFound("Event type not found");
    mockSuggestSlots.mockRejectedValue(engineError);

    await expect(suggestSlotsHandler({ ctx, input: parseInput() })).rejects.toBe(engineError);
  });
});
