export type GreetingPeriod = "morning" | "afternoon" | "evening";

/**
 * The part of the day in the given IANA time zone: morning before noon, afternoon until 18:00,
 * evening after that. The zone is the person's, never the server's or the browser's.
 */
export function greetingPeriod(date: Date, timeZone: string): GreetingPeriod {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(date),
  );
  // Some engines print midnight as "24"; the hour of the day is 0 to 23.
  if (hour % 24 < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}
