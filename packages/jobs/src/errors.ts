/**
 * How a job reports failure (architecture.md §11: distinguish retryable failures from permanent
 * validation or permission failures).
 *
 * Every error carries a short code (`[a-z0-9_.-]`, at most 64 characters) that is logged and stored
 * in Postgres instead of a message, so no personal data or provider response ends up there.
 */

const CODE = /^[a-z0-9_.-]{1,64}$/;

/** A code safe to log and store; anything else becomes `invalid_code`. */
export function safeErrorCode(code: string): string {
  return CODE.test(code) ? code : "invalid_code";
}

/** Trying again later may work: a provider is down, a lock is held, a lease has not expired. */
export class RetryableJobError extends Error {
  readonly code: string;
  /** When a retry can first succeed (another run's lease ends); otherwise the task's backoff. */
  readonly retryAt: Date | undefined;
  constructor(code: string, retryAt?: Date) {
    super(safeErrorCode(code));
    this.name = "RetryableJobError";
    this.code = safeErrorCode(code);
    this.retryAt = retryAt;
  }
}

/**
 * Trying again can never work: the payload is invalid, the resource is gone, or the person no
 * longer has access. The job is not retried; it is recorded as failed for manual recovery.
 */
export class PermanentJobError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(safeErrorCode(code));
    this.name = "PermanentJobError";
    this.code = safeErrorCode(code);
  }
}

export type FailureKind = "retryable" | "permanent";

/** The kind and code of any thrown value; unknown errors are retryable, with a generic code. */
export function classifyError(error: unknown): { kind: FailureKind; code: string } {
  if (error instanceof PermanentJobError) return { kind: "permanent", code: error.code };
  if (error instanceof RetryableJobError) return { kind: "retryable", code: error.code };
  return { kind: "retryable", code: "unexpected_error" };
}
