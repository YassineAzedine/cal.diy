import { describe, expect, it } from "vitest";
import { buildScheduleInput } from "./useSchedule";

const baseArgs = {
  username: "pro",
  eventSlug: "30min",
  eventId: 42,
  timezone: "Europe/London",
  duration: 30,
  rescheduleUid: null,
  isTeamEvent: false,
  orgSlug: undefined,
  teamMemberEmail: null,
};

describe("buildScheduleInput", () => {
  it("builds the getSchedule input without a date range", () => {
    expect(buildScheduleInput(baseArgs, new URLSearchParams())).toEqual({
      isTeamEvent: false,
      usernameList: ["pro"],
      eventTypeSlug: "30min",
      timeZone: "Europe/London",
      duration: "30",
      rescheduleUid: null,
      orgSlug: undefined,
      teamMemberEmail: null,
      routedTeamMemberIds: null,
      skipContactOwner: false,
      email: null,
      embedConnectVersion: "0",
      _isDryRun: false,
    });
  });

  it("prefers the event slug over the event id", () => {
    const input = buildScheduleInput(baseArgs, null);

    expect(input).toHaveProperty("eventTypeSlug", "30min");
    expect(input).not.toHaveProperty("eventTypeId");
  });

  it.each([
    [42, 42],
    [null, 0],
  ])("falls back to the event id %s when there is no slug", (eventId, expected) => {
    const input = buildScheduleInput({ ...baseArgs, eventSlug: null, eventId }, null);

    expect(input).toHaveProperty("eventTypeId", expected);
    expect(input).not.toHaveProperty("eventTypeSlug");
  });

  it("splits dynamic group usernames", () => {
    expect(buildScheduleInput({ ...baseArgs, username: "alice+bob" }, null).usernameList).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("uses a placeholder timezone and no duration when they are missing", () => {
    expect(buildScheduleInput({ ...baseArgs, timezone: null, duration: null }, null)).toMatchObject({
      timeZone: "PLACEHOLDER_TIMEZONE",
      duration: undefined,
    });
  });

  it("reads routing, contact owner, queued response, email, embed and dry-run parameters from the URL", () => {
    const searchParams = new URLSearchParams({
      "cal.routedTeamMemberIds": "1,2",
      "cal.skipContactOwner": "true",
      "cal.queuedFormResponseId": "queued-1",
      email: "booker@example.com",
      "cal.embed.connectVersion": "3",
      "cal.isBookingDryRun": "true",
    });

    expect(buildScheduleInput(baseArgs, searchParams)).toMatchObject({
      routedTeamMemberIds: [1, 2],
      skipContactOwner: true,
      queuedFormResponseId: "queued-1",
      email: "booker@example.com",
      embedConnectVersion: "3",
      _isDryRun: true,
    });
  });

  it("omits the queued form response id when it is absent", () => {
    expect(buildScheduleInput(baseArgs, new URLSearchParams())).not.toHaveProperty("queuedFormResponseId");
  });

  it("passes reschedule, team and organization context through", () => {
    expect(
      buildScheduleInput(
        {
          ...baseArgs,
          rescheduleUid: "booking-uid",
          isTeamEvent: true,
          orgSlug: "acme",
          teamMemberEmail: "host@acme.test",
        },
        null
      )
    ).toMatchObject({
      rescheduleUid: "booking-uid",
      isTeamEvent: true,
      orgSlug: "acme",
      teamMemberEmail: "host@acme.test",
    });
  });
});
