import dayjs from "@calcom/dayjs";
import { useBookerStoreContext } from "@calcom/features/bookings/Booker/BookerStoreProvider";
import { useBookerTime } from "@calcom/features/bookings/Booker/hooks/useBookerTime";
import { useCompatSearchParams } from "@calcom/lib/hooks/useCompatSearchParams";
import type { RouterOutputs } from "@calcom/trpc/react";
import { trpc } from "@calcom/trpc/react";
import { buildScheduleInput } from "@calcom/web/modules/schedules/hooks/useSchedule";
import { useEffect, useRef, useState } from "react";
import { shallow } from "zustand/shallow";

export type SuggestSlotsResponse = RouterOutputs["viewer"]["slots"]["suggestSlots"];

// Every answer carries the query it answers, so the UI never shows it under a different query.
export type BookingAssistantResult = (SuggestSlotsResponse | { status: "rate_limited" }) & { query: string };

export type BookingAssistantState =
  | { status: "idle" }
  | { status: "loading" }
  // The server has the feature off; the assistant hides itself for the rest of the session.
  | { status: "disabled" }
  | BookingAssistantResult;

type UseBookingAssistantArgs = {
  teamMemberEmail?: string | null;
  // The Booker's own slot selection, so reservation and the booking form behave as for a normal click.
  onSlotSelect: (slot: string) => void;
};

export const useBookingAssistant = ({ teamMemberEmail, onSlotSelect }: UseBookingAssistantArgs) => {
  const [username, eventSlug, eventId, selectedDuration, isTeamEvent, org, setSelectedDate] =
    useBookerStoreContext(
      (state) => [
        state.username,
        state.eventSlug,
        state.eventId,
        state.selectedDuration,
        state.isTeamEvent,
        state.org,
        state.setSelectedDate,
      ],
      shallow
    );
  const { timezone, timeFormat } = useBookerTime();
  const searchParams = useCompatSearchParams();
  const suggestSlots = trpc.viewer.slots.suggestSlots.useMutation();
  const [state, setState] = useState<BookingAssistantState>({ status: "idle" });
  // Ignores responses to requests made before the latest submit or context change.
  const requestId = useRef(0);

  const scheduleInput = buildScheduleInput(
    {
      username,
      eventSlug,
      eventId,
      timezone,
      duration: selectedDuration,
      rescheduleUid: searchParams?.get("rescheduleUid"),
      isTeamEvent,
      orgSlug: org ?? undefined,
      teamMemberEmail,
    },
    searchParams
  );
  // Answers are only valid for the exact input they were computed from. The calendar's selected date
  // and month are deliberately not part of it: suggestions answer the query, not the visible calendar.
  const requestContextKey = JSON.stringify(scheduleInput);

  useEffect(() => {
    requestId.current += 1;
    setState((current) => (current.status === "disabled" ? current : { status: "idle" }));
  }, [requestContextKey]);

  const suggest = (query: string) => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery || !timezone) return;

    const currentRequest = ++requestId.current;
    setState({ status: "loading" });
    suggestSlots.mutate(
      { ...scheduleInput, query: trimmedQuery },
      {
        onSuccess: (response) => {
          if (currentRequest === requestId.current) setState({ ...response, query: trimmedQuery });
        },
        onError: (error) => {
          if (currentRequest !== requestId.current) return;
          const code = error.data?.code;
          if (code === "NOT_FOUND") return setState({ status: "disabled" });
          setState({
            status: code === "TOO_MANY_REQUESTS" ? "rate_limited" : "unavailable",
            query: trimmedQuery,
          });
        },
      }
    );
  };

  const selectSuggestion = (slot: string) => {
    // The date picker works in the booker's local dates, which can differ from the slot's UTC date.
    setSelectedDate({ date: dayjs(slot).tz(timezone).format("YYYY-MM-DD") });
    onSlotSelect(slot);
  };

  return { state, suggest, selectSuggestion, timezone, timeFormat };
};
