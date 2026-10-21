/** Logs by event and short code only: never ids, titles, instructions, notes, reasons or names. */
export function logChores(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}
