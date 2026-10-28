/** Logs by event and short code only: never ids, habit names, notes or reasons. */
export function logHabits(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}
