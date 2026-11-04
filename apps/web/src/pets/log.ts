/** Logs by event and short code only: never ids, pet names or any medical detail. */
export function logPets(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}
