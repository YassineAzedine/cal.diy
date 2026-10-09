import dayjs from "@calcom/dayjs";
import { BOOKING_ASSISTANT_LIMITS } from "@calcom/features/booking-assistant/lib/limits";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";
import { TextField } from "@calcom/ui/components/form";
import type { FormEvent } from "react";
import { useState } from "react";
import type { SuggestSlotsResponse } from "../hooks/useBookingAssistant";
import { useBookingAssistant } from "../hooks/useBookingAssistant";

type Interpretation = Extract<SuggestSlotsResponse, { interpretation: unknown }>["interpretation"];

const EXAMPLE_PROMPT_KEYS = [
  "booking_assistant_example_tomorrow_morning",
  "booking_assistant_example_next_tuesday_afternoon",
  "booking_assistant_example_friday_after_3pm",
] as const;

type BookingAssistantProps = {
  teamMemberEmail?: string | null;
  onSlotSelect: (slot: string) => void;
};

// Interpretation dates are calendar days, so they are formatted in UTC to avoid shifting a day.
const formatCalendarDate = (date: string, locale: string) =>
  new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));

// 2023-01-01 was a Sunday, matching the 0 = Sunday weekday numbering.
const formatWeekday = (weekday: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(2023, 0, 1 + weekday))
  );

const formatClockTime = (time: string, timeFormat: string) =>
  dayjs.utc(`2000-01-01T${time}:00Z`).format(timeFormat);

const formatInterpretation = (interpretation: Interpretation, locale: string, timeFormat: string) => {
  const { dateFrom, dateTo, timeWindows, weekdays } = interpretation;
  const dates =
    dateFrom === dateTo
      ? formatCalendarDate(dateFrom, locale)
      : `${formatCalendarDate(dateFrom, locale)} – ${formatCalendarDate(dateTo, locale)}`;
  const days = weekdays.map((weekday) => formatWeekday(weekday, locale)).join(", ");
  const times = timeWindows
    .map(({ from, to }) => `${formatClockTime(from, timeFormat)}–${formatClockTime(to, timeFormat)}`)
    .join(", ");
  return [dates, days, times].filter(Boolean).join(" · ");
};

export const BookingAssistant = ({ teamMemberEmail, onSlotSelect }: BookingAssistantProps) => {
  const { t, i18n } = useLocale();
  const { state, suggest, selectSuggestion, timezone, timeFormat } = useBookingAssistant({
    teamMemberEmail,
    onSlotSelect,
  });
  const [query, setQuery] = useState("");

  if (state.status === "disabled") return null;

  const isLoading = state.status === "loading";
  const locale = i18n.language;
  // An answer is shown only while the input still holds the query it answers; editing hides it.
  const result = "query" in state && state.query === query.trim() ? state : null;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    suggest(query);
  };

  // An example fills the input too, so the booker can see and refine what was asked.
  const runExample = (example: string) => {
    setQuery(example);
    suggest(example);
  };

  const formatSlot = (slot: string) => {
    const local = dayjs(slot).tz(timezone);
    return `${formatCalendarDate(local.format("YYYY-MM-DD"), locale)} · ${local.format(timeFormat)}`;
  };

  return (
    <section className="px-5 py-3" data-testid="booking-assistant">
      <div className="border-subtle bg-default rounded-lg border p-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <TextField
            name="booking-assistant-query"
            label={t("booking_assistant_label")}
            placeholder={t("booking_assistant_placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={BOOKING_ASSISTANT_LIMITS.maxQueryLength}
            disabled={isLoading}
            containerClassName="w-full"
          />
          <div role="group" aria-label={t("booking_assistant_examples")} className="flex flex-wrap gap-2">
            {EXAMPLE_PROMPT_KEYS.map((key) => (
              <Button
                key={key}
                type="button"
                size="xs"
                color="secondary"
                className="rounded-full"
                disabled={isLoading}
                onClick={() => runExample(t(key))}>
                {t(key)}
              </Button>
            ))}
          </div>
          <Button
            type="submit"
            StartIcon="sparkles"
            className="w-full justify-center"
            loading={isLoading}
            disabled={!query.trim()}>
            {t("booking_assistant_submit")}
          </Button>
        </form>
        <p className="text-muted mt-2 text-xs">{t("booking_assistant_ai_disclosure")}</p>
      </div>

      {/* Never display:none, so screen readers announce results when they appear. */}
      <div aria-live="polite" className="flex flex-col gap-2 text-sm [&:not(:empty)]:mt-4">
        {(result?.status === "ok" || result?.status === "no_match") && (
          <p className="text-subtle" data-testid="booking-assistant-interpretation">
            {t("booking_assistant_interpretation", {
              interpretation: formatInterpretation(result.interpretation, locale, timeFormat),
            })}
          </p>
        )}
        {result?.status === "ok" && (
          <ul className="flex flex-col gap-2" aria-label={t("booking_assistant_suggestions")}>
            {result.slots.map((slot) => (
              <li key={slot}>
                <Button
                  color="secondary"
                  className="w-full justify-center"
                  onClick={() => selectSuggestion(slot)}>
                  {formatSlot(slot)}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {result?.status === "no_match" && <p className="text-default">{t("booking_assistant_no_match")}</p>}
        {result?.status === "not_understood" && (
          <p className="text-default">{t("booking_assistant_not_understood")}</p>
        )}
        {result?.status === "unavailable" && (
          <p className="text-default">{t("booking_assistant_unavailable")}</p>
        )}
        {result?.status === "rate_limited" && (
          <p className="text-default">{t("booking_assistant_rate_limited")}</p>
        )}
      </div>
    </section>
  );
};
