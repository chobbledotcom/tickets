/**
 * Evidence from the app server's own log that one signed webhook arrived and
 * what it did. Only the webhook route writes these lines, so a line is
 * independent of anything the visitor's browser shows.
 */

import { config } from "#e2e/config.ts";
import type { LiveWorld } from "#e2e/cucumber/support/world.ts";
import { lastLoggedMatch } from "#e2e/providers/shared.ts";
import { pollUntil } from "#e2e/util.ts";

/**
 * The webhook route's own words for what one delivered callback amounted to.
 * Only that route writes `[Webhook] Payment callback …`, so such a line is
 * independent evidence that the callback arrived through the tunnel, that its
 * signature verified, and that its session resolved into the payment engine.
 * The roster alone can never show this, because the visitor's browser return
 * can book first.
 */
const WEBHOOK_DID = {
  booked: "booked",
  terminalized: "settled without a booking",
} as const;

/**
 * The concurrency guard's words. They prove the same delivery, verification
 * and resolution, but they also say this delivery did NOT do the work:
 * another request held the reservation. So a held line is accepted only when
 * the step's own outcome never arrives — Stripe redelivers a 409 on a
 * schedule a nightly cannot wait out — and it is recorded under its own name,
 * so the journal never credits a held delivery with work it did not do.
 */
const WEBHOOK_HELD = "is being processed elsewhere";

/** The webhook's log line for one outcome, carrying that outcome as its value. */
const callbackLine = (outcome: string): string =>
  `\\[Webhook\\] Payment callback (${outcome})`;

/** Build the follow-up check that waits for the signed webhook's own log
 * line — never inferred from pages. The step's own outcome is preferred for
 * the whole window, so a race that is merely slow still proves the real
 * thing. */
export const webhookEvidenceThen =
  (did: keyof typeof WEBHOOK_DID) =>
  async (world: LiveWorld): Promise<void> => {
    const logPath = world.resources.server.logPath;
    const processed = await pollUntil(config.paymentConfirmTimeoutMs, () =>
      Promise.resolve(lastLoggedMatch(logPath, callbackLine(WEBHOOK_DID[did]))),
    );
    if (processed !== null) {
      world.recordPhase(`webhook-${did}`);
      return;
    }
    if (lastLoggedMatch(logPath, callbackLine(WEBHOOK_HELD)) === null) {
      throw new Error(
        `the app server log carries no '[Webhook] Payment callback ` +
          `${WEBHOOK_DID[did]}' line, so the signed webhook never reached ` +
          `that outcome (${logPath})`,
      );
    }
    world.recordPhase("webhook-held-by-another-request");
  };
