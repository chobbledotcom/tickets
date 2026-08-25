/**
 * The wait loop for a provider's hosted page after Pay was clicked. The loop
 * is pure policy: the page probes, the clock and the waits come in as
 * functions, so the order and the cadence have direct tests. The provider
 * file keeps only the Playwright wiring (sumup.ts).
 */

/** What the provider's page did after Pay was clicked. */
export type AfterPayOutcome =
  | "left_provider"
  | "declined"
  | "clicked_back"
  | "timed_out";

/** How the loop asks the page what it shows now. */
export interface AfterPayProbes {
  /** Click the "back to the app" control when it is there. True when clicked. */
  clickBack: () => Promise<boolean>;
  /** Is the provider's decline banner visible? */
  declineVisible: () => Promise<boolean>;
  /** Is the browser still on the provider's origin? */
  onProvider: () => boolean;
}

/** The clock the loop runs on. Production passes Date.now and the page's own
 * wait, and tests pass a scripted clock, so no test sleeps for real. */
export interface AfterPayClock {
  now: () => number;
  wait: (ms: number) => Promise<void>;
}

const POLL_MS = 500;

/**
 * Watch the page until it leaves the provider, shows a decline, offers a way
 * back, or the deadline passes. A decline outranks the back control: a
 * declined page never goes home, so there is nothing to wait for.
 */
export const watchAfterPay = async (
  probes: AfterPayProbes,
  clock: AfterPayClock,
  deadlineMs: number,
): Promise<AfterPayOutcome> => {
  const deadline = clock.now() + deadlineMs;
  while (clock.now() < deadline) {
    if (!probes.onProvider()) return "left_provider";
    if (await probes.declineVisible()) return "declined";
    if (await probes.clickBack()) return "clicked_back";
    // The last wait shrinks to the time left, so the deadline holds exactly.
    await clock.wait(Math.min(POLL_MS, deadline - clock.now()));
  }
  return "timed_out";
};
