/**
 * Request header with the requested path and query, so a page can send a signed-out visitor to
 * sign-in and back. `src/proxy.ts` always overwrites it, and readers pass it through
 * `safeNextPath`, so a value sent from outside cannot redirect anywhere else.
 */
export const PATH_HEADER = "x-madeora-path";
