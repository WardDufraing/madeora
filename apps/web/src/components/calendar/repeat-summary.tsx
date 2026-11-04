"use client";

import type { IsoWeekday } from "@madeora/domain/tasks";

import type { RepeatShape } from "@/calendar/shapes";
import { useRecurrenceText } from "@/components/tasks/repeat-fields";
import type { DateFormat } from "@/preferences/schema";

function isIsoWeekday(value: number): value is IsoWeekday {
  return Number.isInteger(value) && value >= 1 && value <= 7;
}

/** A recurring event's schedule in plain words, e.g. "Every week on Monday, 6 times". */
export function RepeatSummary({
  repeat,
  startsOn,
  dateFormat,
}: {
  readonly repeat: RepeatShape;
  readonly startsOn: string;
  readonly dateFormat: DateFormat;
}) {
  const text = useRecurrenceText(dateFormat);
  return (
    <>
      {text.rule({
        frequency: repeat.frequency,
        interval: repeat.interval,
        weekdays: repeat.weekdays ? repeat.weekdays.filter(isIsoWeekday) : null,
        startsOn,
        endsOn: repeat.endsOn,
        count: repeat.count,
      })}
    </>
  );
}
