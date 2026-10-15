import { CORRELATION_HEADER, isCorrelationId, newCorrelationId } from "@madeora/observability";

/**
 * The correlation ID of this request (architecture.md §22): the one `proxy.ts` set, or a fresh
 * one where the proxy did not run (its matcher skips build assets; tests call handlers directly).
 * Pass it to structured logs and to jobs enqueued for this request.
 */
export function requestCorrelationId(request: Pick<Request, "headers">): string {
  const id = request.headers.get(CORRELATION_HEADER);
  return isCorrelationId(id) ? id : newCorrelationId();
}
