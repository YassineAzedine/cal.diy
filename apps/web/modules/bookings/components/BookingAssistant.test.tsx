import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingAssistantState } from "../hooks/useBookingAssistant";
import { BookingAssistant } from "./BookingAssistant";

const { hookState, mockSuggest, mockSelectSuggestion } = vi.hoisted(() => ({
  hookState: {
    state: { status: "idle" } as BookingAssistantState,
    timezone: "Europe/London",
    timeFormat: "HH:mm",
  },
  mockSuggest: vi.fn(),
  mockSelectSuggestion: vi.fn(),
}));

vi.mock("../hooks/useBookingAssistant", () => ({
  useBookingAssistant: () => ({ ...hookState, suggest: mockSuggest, selectSuggestion: mockSelectSuggestion }),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, options?: { interpretation?: string }) =>
      options?.interpretation ? `${key}: ${options.interpretation}` : key,
    i18n: { language: "en-GB" },
  }),
}));

const interpretation = {
  dateFrom: "2026-10-13",
  dateTo: "2026-10-13",
  timeWindows: [{ from: "12:00", to: "17:00" }],
  weekdays: [],
  preference: "earliest" as const,
};

const SUBMITTED_QUERY = "next tuesday afternoon";
const RESULT_STATUSES = ["ok", "no_match", "not_understood", "unavailable", "rate_limited"];

type StateFixture = { status: string } & Record<string, unknown>;

// Answers carry the query they answer. In real use the input holds that query when the answer
// arrives, so the helper types it in for answer states.
const renderAssistant = (fixture: StateFixture, overrides: Partial<typeof hookState> = {}) => {
  const state = (
    RESULT_STATUSES.includes(fixture.status) && !("query" in fixture)
      ? { ...fixture, query: SUBMITTED_QUERY }
      : fixture
  ) as BookingAssistantState;
  Object.assign(hookState, { timezone: "Europe/London", timeFormat: "HH:mm", ...overrides, state });
  const view = render(<BookingAssistant onSlotSelect={vi.fn()} />);
  if ("query" in state) fireEvent.change(screen.getByRole("textbox"), { target: { value: state.query } });
  return view;
};

const queryInput = () => screen.getByRole("textbox");
const submitButton = () => screen.getByRole("button", { name: "booking_assistant_submit" });

describe("BookingAssistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("form", () => {
    it("shows the labelled input and the AI disclosure", () => {
      renderAssistant({ status: "idle" });

      expect(screen.getByLabelText("booking_assistant_label")).toBe(queryInput());
      expect(screen.getByText("booking_assistant_ai_disclosure")).toBeInTheDocument();
      expect(queryInput()).toHaveAttribute("maxLength", "200");
    });

    it("only enables submitting once something is typed", () => {
      renderAssistant({ status: "idle" });
      expect(submitButton()).toBeDisabled();

      fireEvent.change(queryInput(), { target: { value: "   " } });
      expect(submitButton()).toBeDisabled();

      fireEvent.change(queryInput(), { target: { value: "next tuesday afternoon" } });
      expect(submitButton()).toBeEnabled();
    });

    it("submits the typed query", () => {
      renderAssistant({ status: "idle" });

      fireEvent.change(queryInput(), { target: { value: "next tuesday afternoon" } });
      fireEvent.submit(queryInput().closest("form") as HTMLFormElement);

      expect(mockSuggest).toHaveBeenCalledWith("next tuesday afternoon");
    });

    it("disables the input while loading", () => {
      renderAssistant({ status: "loading" });

      expect(queryInput()).toBeDisabled();
    });
  });

  describe("example prompts", () => {
    const examples = [
      "booking_assistant_example_tomorrow_morning",
      "booking_assistant_example_next_tuesday_afternoon",
      "booking_assistant_example_friday_after_3pm",
    ];

    it("offers the examples in a labelled group", () => {
      renderAssistant({ status: "idle" });

      const group = screen.getByRole("group", { name: "booking_assistant_examples" });
      for (const example of examples) {
        expect(within(group).getByRole("button", { name: example })).toBeInTheDocument();
      }
    });

    it("fills the input and searches when an example is chosen", () => {
      renderAssistant({ status: "idle" });

      fireEvent.click(screen.getByRole("button", { name: "booking_assistant_example_friday_after_3pm" }));

      expect(queryInput()).toHaveValue("booking_assistant_example_friday_after_3pm");
      expect(mockSuggest).toHaveBeenCalledWith("booking_assistant_example_friday_after_3pm");
    });

    it("disables the examples while a search is running", () => {
      renderAssistant({ status: "loading" });

      for (const example of examples) {
        expect(screen.getByRole("button", { name: example })).toBeDisabled();
      }
    });
  });

  describe("results", () => {
    it("shows the interpretation and suggestions in the booker's timezone", () => {
      renderAssistant({
        status: "ok",
        slots: ["2026-10-13T11:00:00.000Z", "2026-10-13T11:30:00.000Z"],
        interpretation,
      });

      expect(screen.getByTestId("booking-assistant-interpretation")).toHaveTextContent(
        "booking_assistant_interpretation: Tue 13 Oct · 12:00–17:00"
      );
      // London is UTC+1 in October.
      expect(screen.getByRole("button", { name: "Tue 13 Oct · 12:00" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tue 13 Oct · 12:30" })).toBeInTheDocument();
    });

    it("uses the booker's 12-hour preference and local date", () => {
      renderAssistant(
        { status: "ok", slots: ["2026-10-13T20:00:00.000Z"], interpretation },
        { timezone: "Asia/Kolkata", timeFormat: "h:mma" }
      );

      expect(screen.getByTestId("booking-assistant-interpretation")).toHaveTextContent(
        "Tue 13 Oct · 12:00pm–5:00pm"
      );
      // 20:00 UTC is 01:30 on the 14th in Kolkata.
      expect(screen.getByRole("button", { name: "Wed 14 Oct · 1:30am" })).toBeInTheDocument();
    });

    it("selects the exact slot string when a suggestion is clicked", () => {
      renderAssistant({ status: "ok", slots: ["2026-10-13T11:00:00.000Z"], interpretation });

      fireEvent.click(screen.getByRole("button", { name: "Tue 13 Oct · 12:00" }));

      expect(mockSelectSuggestion).toHaveBeenCalledWith("2026-10-13T11:00:00.000Z");
    });

    it("describes date ranges and weekdays in the interpretation", () => {
      renderAssistant({
        status: "no_match",
        interpretation: {
          ...interpretation,
          dateTo: "2026-10-30",
          weekdays: [1, 5],
          timeWindows: [],
        },
      });

      expect(screen.getByTestId("booking-assistant-interpretation")).toHaveTextContent(
        "Tue 13 Oct – Fri 30 Oct · Mon, Fri"
      );
    });

    it.each<[string, StateFixture]>([
      ["booking_assistant_no_match", { status: "no_match", interpretation }],
      ["booking_assistant_not_understood", { status: "not_understood" }],
      ["booking_assistant_unavailable", { status: "unavailable" }],
      ["booking_assistant_rate_limited", { status: "rate_limited" }],
    ])("shows %s", (message, state) => {
      renderAssistant(state);

      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
    });

    it("renders nothing once the server reports the feature off", () => {
      const { container } = renderAssistant({ status: "disabled" });

      expect(container).toBeEmptyDOMElement();
    });
  });

  describe("stale answers", () => {
    const okState = { status: "ok", slots: ["2026-10-13T11:00:00.000Z"], interpretation };

    it("hides the interpretation and suggestions as soon as the query is edited", () => {
      renderAssistant(okState);
      expect(screen.getByRole("list")).toBeInTheDocument();

      fireEvent.change(queryInput(), { target: { value: "next wednesday morning" } });

      expect(screen.queryByTestId("booking-assistant-interpretation")).not.toBeInTheDocument();
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
    });

    it("shows the answer again if the query is changed back to the one it answers", () => {
      renderAssistant(okState);
      fireEvent.change(queryInput(), { target: { value: "next wednesday morning" } });

      fireEvent.change(queryInput(), { target: { value: `  ${SUBMITTED_QUERY} ` } });

      expect(screen.getByRole("list")).toBeInTheDocument();
    });

    it.each<[string, StateFixture]>([
      ["booking_assistant_no_match", { status: "no_match", interpretation }],
      ["booking_assistant_not_understood", { status: "not_understood" }],
      ["booking_assistant_unavailable", { status: "unavailable" }],
      ["booking_assistant_rate_limited", { status: "rate_limited" }],
    ])("hides %s once the query is edited", (message, state) => {
      renderAssistant(state);

      fireEvent.change(queryInput(), { target: { value: "something else" } });

      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it("never shows an answer under an empty input", () => {
      renderAssistant(okState);

      fireEvent.change(queryInput(), { target: { value: "" } });

      expect(screen.queryByRole("list")).not.toBeInTheDocument();
    });
  });
});
