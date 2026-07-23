export const CHECKOUT_STAGE_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

const RETRY_DELAYS_MS = [
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
] as const;

/** Delay a failed stage without ever abandoning money that still needs work. */
export const checkoutStageRetryDelay = (attemptCount: number): number =>
  RETRY_DELAYS_MS[Math.min(attemptCount, RETRY_DELAYS_MS.length - 1)]!;
