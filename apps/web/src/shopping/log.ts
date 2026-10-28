/** Logs by event and short code only: never ids, list or item names, quantities or notes. */
export function logShopping(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}
