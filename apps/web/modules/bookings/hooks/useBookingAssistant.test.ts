// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBookingAssistant } from "./useBookingAssistant";

const { mockMutate, mockSetSelectedDate, bookerTime, storeState, searchParams } = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  mockSetSelectedDate: vi.fn(),
  bookerTime: { timezone: "Europe/London", timeFormat: "HH:mm" },
  storeState: {
    username: "pro",
    eventSlug: "30min",
    eventId: 42,
    selectedDuration: 30 as number | null,
    isTeamEvent: false,
    org: null as string | null,
    selectedDate: "2026-10-09" as string | null,
    month: "2026-10" as string | null,
  },
  searchParams: { current: new URLSearchParams() },
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: { viewer: { slots: { suggestSlots: { useMutation: () => ({ mutate: mockMutate }) } } } },
}));

vi.mock("@calcom/features/bookings/Booker/BookerStoreProvider", () => ({
  useBookerStoreContext: <T>(selector: (state: unknown) => T) =>
    selector({ ...storeState, setSelectedDate: mockSetSelectedDate }),
}));

vi.mock("@calcom/features/bookings/Booker/hooks/useBookerTime", () => ({
  useBookerTime: () => bookerTime,
}));

vi.mock("@calcom/lib/hooks/useCompatSearchParams", () => ({
  useCompatSearchParams: () => searchParams.current,
}));

type MutateOptions = {
  onSuccess: (response: unknown) => void;
  onError: (error: { data?: { code?: string } }) => void;
};

const lastMutateCall = () => {
  const [input, options] = mockMutate.mock.calls[mockMutate.mock.calls.length - 1];
  return { input, options: options as MutateOptions };
};

const interpretation = {
  dateFrom: "2026-10-13",
  dateTo: "2026-10-13",
  timeWindows: [{ from: "12:00", to: "17:00" }],
  weekdays: [],
  preference: "earliest" as const,
};

const okResponse = { status: "ok" as const, slots: ["2026-10-13T11:00:00.000Z"], interpretation };

const setup = () => {
  const onSlotSelect = vi.fn();
  const hook = renderHook(
    ({ teamMemberEmail }: { teamMemberEmail: string | null }) =>
      useBookingAssistant({ teamMemberEmail, onSlotSelect }),
    { initialProps: { teamMemberEmail: null as string | null } }
  );
  return { ...hook, onSlotSelect };
};

const answer = (result: ReturnType<typeof setup>["result"], response: unknown = okResponse) => {
  act(() => result.current.suggest("tuesday"));
  act(() => lastMutateCall().options.onSuccess(response));
};

describe("useBookingAssistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bookerTime.timezone = "Europe/London";
    storeState.selectedDuration = 30;
    storeState.selectedDate = "2026-10-09";
    storeState.month = "2026-10";
    searchParams.current = new URLSearchParams();
  });

  describe("requests", () => {
    it("sends the Booker's schedule input with the trimmed query and no date range", () => {
      searchParams.current = new URLSearchParams({ rescheduleUid: "booking-uid" });
      const { result } = setup();

      act(() => result.current.suggest("  next tuesday afternoon  "));

      const { input } = lastMutateCall();
      expect(input).toMatchObject({
        query: "next tuesday afternoon",
        usernameList: ["pro"],
        eventTypeSlug: "30min",
        timeZone: "Europe/London",
        duration: "30",
        rescheduleUid: "booking-uid",
        isTeamEvent: false,
      });
      expect(input).not.toHaveProperty("startTime");
      expect(input).not.toHaveProperty("endTime");
    });

    it("never sends the calendar's selected date or month", () => {
      searchParams.current = new URLSearchParams({ date: "2026-10-20", month: "2026-10" });
      const { result } = setup();

      act(() => result.current.suggest("tuesday"));

      const sent = JSON.stringify(lastMutateCall().input);
      expect(sent).not.toContain("2026-10-20");
      expect(sent).not.toContain("2026-10-09");
      expect(lastMutateCall().input).not.toHaveProperty("selectedDate");
      expect(lastMutateCall().input).not.toHaveProperty("month");
    });

    it.each(["", "   "])("does not send an empty query (%j)", (query) => {
      const { result } = setup();

      act(() => result.current.suggest(query));

      expect(mockMutate).not.toHaveBeenCalled();
      expect(result.current.state).toEqual({ status: "idle" });
    });

    it("shows loading until the server answers", () => {
      const { result } = setup();

      act(() => result.current.suggest("tuesday"));

      expect(result.current.state).toEqual({ status: "loading" });
    });
  });

  describe("responses", () => {
    it.each([
      okResponse,
      { status: "no_match" as const, interpretation },
      { status: "not_understood" as const },
      { status: "unavailable" as const },
    ])("tags the $status response with the query it answers", (response) => {
      const { result } = setup();

      answer(result, response);

      expect(result.current.state).toEqual({ ...response, query: "tuesday" });
    });

    it.each([
      ["TOO_MANY_REQUESTS", { status: "rate_limited", query: "tuesday" }],
      ["NOT_FOUND", { status: "disabled" }],
      ["INTERNAL_SERVER_ERROR", { status: "unavailable", query: "tuesday" }],
      [undefined, { status: "unavailable", query: "tuesday" }],
    ])("maps the %s error to %o", (code, expected) => {
      const { result } = setup();
      act(() => result.current.suggest("tuesday"));

      act(() => lastMutateCall().options.onError({ data: code ? { code } : undefined }));

      expect(result.current.state).toEqual(expected);
    });

    it("ignores the answer to a request that a newer one replaced", () => {
      const { result } = setup();
      act(() => result.current.suggest("tuesday"));
      const firstRequest = lastMutateCall().options;
      act(() => result.current.suggest("wednesday"));

      act(() => firstRequest.onSuccess(okResponse));

      expect(result.current.state).toEqual({ status: "loading" });
    });
  });

  describe("context changes", () => {
    it("clears suggestions and ignores late answers when the timezone changes", () => {
      const { result, rerender } = setup();
      act(() => result.current.suggest("tuesday"));
      const pendingRequest = lastMutateCall().options;

      bookerTime.timezone = "America/New_York";
      rerender({ teamMemberEmail: null });
      act(() => pendingRequest.onSuccess(okResponse));

      expect(result.current.state).toEqual({ status: "idle" });
    });

    it.each<[string, (rerender: ReturnType<typeof setup>["rerender"]) => void]>([
      [
        "the duration",
        (rerender) => {
          storeState.selectedDuration = 60;
          rerender({ teamMemberEmail: null });
        },
      ],
      [
        "the reschedule booking",
        (rerender) => {
          searchParams.current = new URLSearchParams({ rescheduleUid: "other-booking" });
          rerender({ teamMemberEmail: null });
        },
      ],
      [
        "the routed team members",
        (rerender) => {
          searchParams.current = new URLSearchParams({ "cal.routedTeamMemberIds": "7" });
          rerender({ teamMemberEmail: null });
        },
      ],
      ["the team member", (rerender) => rerender({ teamMemberEmail: "host@acme.test" })],
    ])("clears suggestions when %s changes", (_, change) => {
      const { result, rerender } = setup();
      answer(result);

      change(rerender);

      expect(result.current.state).toEqual({ status: "idle" });
    });

    it("keeps suggestions when the booker navigates the calendar", () => {
      const { result, rerender } = setup();
      answer(result);

      storeState.selectedDate = "2026-10-20";
      storeState.month = "2026-11";
      searchParams.current = new URLSearchParams({ date: "2026-10-20", month: "2026-11" });
      rerender({ teamMemberEmail: null });

      expect(result.current.state).toEqual({ ...okResponse, query: "tuesday" });
    });

    it("stays disabled after a context change once the server reported the feature off", () => {
      const { result, rerender } = setup();
      act(() => result.current.suggest("tuesday"));
      act(() => lastMutateCall().options.onError({ data: { code: "NOT_FOUND" } }));

      bookerTime.timezone = "Asia/Tokyo";
      rerender({ teamMemberEmail: null });

      expect(result.current.state).toEqual({ status: "disabled" });
    });
  });

  describe("selecting a suggestion", () => {
    it("selects the booker's local date, then the exact slot through the Booker's own handler", () => {
      // 20:00 UTC on the 13th is already 01:30 on the 14th in Kolkata.
      bookerTime.timezone = "Asia/Kolkata";
      const { result, onSlotSelect } = setup();

      act(() => result.current.selectSuggestion("2026-10-13T20:00:00.000Z"));

      expect(mockSetSelectedDate).toHaveBeenCalledWith({ date: "2026-10-14" });
      expect(onSlotSelect).toHaveBeenCalledWith("2026-10-13T20:00:00.000Z");
      expect(mockSetSelectedDate.mock.invocationCallOrder[0]).toBeLessThan(
        onSlotSelect.mock.invocationCallOrder[0]
      );
    });
  });
});
