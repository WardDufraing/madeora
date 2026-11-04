import type { EventDetail, Occurrence } from "./shapes";

/** Fixtures for the calendar tests (S32). Not used by the app. */
export const HOME = "0b0e0000-0000-4000-8000-000000000001";
export const OTHER_HOME = "0b0e0000-0000-4000-8000-000000000002";
export const EVENT = "0b0e0000-0000-4000-8000-000000000003";
export const NEW_EVENT = "0b0e0000-0000-4000-8000-000000000004";
export const MEMBERSHIP = "0b0e0000-0000-4000-8000-000000000005";
export const OTHER_MEMBERSHIP = "0b0e0000-0000-4000-8000-000000000006";

export function occurrence(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    eventId: EVENT,
    on: null,
    kind: "home",
    sharedBy: null,
    title: "Dentist",
    location: null,
    allDay: false,
    from: "2026-11-10",
    to: "2026-11-10",
    startsAt: "2026-11-10T08:00:00.000Z",
    endsAt: "2026-11-10T09:00:00.000Z",
    timezone: "Europe/Brussels",
    recurring: false,
    changed: false,
    participants: [],
    ...overrides,
  };
}

const times = {
  description: null,
  startsOn: "2026-11-10",
  endsOn: "2026-11-10",
  startTime: "09:00",
  endTime: "10:00",
};

/** A weekly Home event shown on its second occurrence (17 November). */
export function eventDetail(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    id: EVENT,
    homeId: HOME,
    kind: "home",
    sharedBy: null,
    revision: 3,
    reminder: null,
    displayTimezone: "Europe/Brussels",
    series: { ...occurrence({ recurring: true, on: "2026-11-10" }), ...times },
    repeat: {
      frequency: "weekly",
      interval: 1,
      weekdays: [2],
      endsOn: null,
      count: 6,
      until: "2026-12-15",
    },
    occurrence: {
      ...occurrence({
        recurring: true,
        on: "2026-11-17",
        from: "2026-11-17",
        to: "2026-11-17",
        startsAt: "2026-11-17T08:00:00.000Z",
        endsAt: "2026-11-17T09:00:00.000Z",
      }),
      ...times,
      startsOn: "2026-11-17",
      endsOn: "2026-11-17",
      first: false,
    },
    shares: null,
    canEdit: true,
    canDelete: true,
    exceptions: 0,
    ...overrides,
  };
}
