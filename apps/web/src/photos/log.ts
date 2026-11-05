/** Logs by event and short code only: never ids, album names or anything about a picture. */
export function logPhotos(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}
