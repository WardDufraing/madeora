/** Logs by event and short code only: never ids, names, ingredients, steps, notes or tags. */
export function logRecipes(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}
