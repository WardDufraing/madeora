/** Logs by event and short code only: never ids, meal titles, notes or recipe names. */
export function logMeals(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}
