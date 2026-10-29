/** Logs by event and short code only: never ids, goal titles, notes or reasons. */
export function logGoals(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}
