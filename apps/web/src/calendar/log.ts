/** Logs by event and short code only: never ids, titles, places or times of events. */
export function logCalendar(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}
