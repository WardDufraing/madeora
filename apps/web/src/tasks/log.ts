/** Logs by event and short code only: never ids, titles, descriptions, comments or names. */
export function logTasks(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}
