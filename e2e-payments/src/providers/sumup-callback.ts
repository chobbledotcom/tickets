import { readFileSync } from "node:fs";
import type { BrowserSession } from "#e2e/browser.ts";
import { config } from "#e2e/config.ts";
import { assertBookedInAdmin } from "#e2e/flow.ts";
import { log, step } from "#e2e/log.ts";
import { pollUntil } from "#e2e/util.ts";
import { readLoggedId } from "./shared.ts";
import type { HostedCheckoutContext } from "./types.ts";

/**
 * SumUp's unsigned callback contract, exercised against the real sandbox.
 *
 * SumUp's own webhook delivery cannot be awaited deterministically (it retries
 * a handful of times over hours), so after the browser journey confirms the
 * booking we deliver the same callback SumUp would send — the tiny
 * `{ event_type, id }` body carrying the REAL sandbox checkout id — and assert
 * the app walks its whole observation path on genuine data: the staged-row
 * pre-filter, the live re-fetch from SumUp, the classifier, and the sealed-row
 * open, resolving the already-booked checkout without double-booking it.
 *
 * Forged, oversized, empty, and missing ids must all take the one fixed
 * refusal — identical status, header, and body — so an unsigned forger learns
 * nothing from the answer's shape, and must do so without costing a SumUp
 * read.
 */

/** The one answer every locally refused callback gets, byte for byte. */
const FIXED_REFUSAL = {
  body: "Payment verification failed",
  contentType: "text/plain; charset=utf-8",
  status: 503,
} as const;

/** The id line createCheckout logs once the staged row carries the SumUp id. */
const SUMUP_ID_LINE = {
  expected: "[SumUp] Checkout created id=…",
  pattern: /\[SumUp\] Checkout created id=(\S+)/g,
} as const;

/** Server-log lines that show what a callback cost. The app writes
 * "[SumUp] Checkout read …" whenever a read reached out to SumUp and failed
 * (src/shared/sumup.ts — a forged id that slipped past the pre-filter would
 * show up here as a 404), and one "SumUp callback refused retryably" line per
 * refused callback (src/shared/sumup-provider.ts). */
const CHECKOUT_READ_LINES = /\[SumUp\] Checkout read /g;
const REFUSAL_LINES = /\[Webhook\] SumUp callback refused retryably/g;

/** Count the server-log lines matching one of the patterns above. */
const countLogMatches = (logPath: string, pattern: RegExp): number =>
  readFileSync(logPath, "utf8").match(pattern)?.length ?? 0;

/** Deliver a SumUp-shaped callback to the app; `id` omitted sends a body
 * with no id field at all. Bounded so a wedged tunnel fails the leg promptly
 * instead of hanging it. */
const postCallback = (baseUrl: string, id?: string): Promise<Response> =>
  fetch(`${baseUrl}/payment/webhook`, {
    body: JSON.stringify({
      event_type: "CHECKOUT_STATUS_CHANGED",
      ...(id === undefined ? {} : { id }),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(config.navTimeoutMs),
  });

/** Build a check that reads the answer and throws a labeled error when it
 * misses the contract. The judge returns what went wrong, or null when the
 * answer is right. */
const answerCheck =
  (judge: (response: Response, body: string) => string | null) =>
  async (response: Response, what: string): Promise<void> => {
    const body = await response.text();
    const problem = judge(response, body);
    if (problem !== null) throw new Error(`SumUp ${what}: ${problem}`);
  };

/** The genuine callback must be acknowledged as processed. */
const expectProcessed = answerCheck((answer, body) => {
  if (answer.status !== 200) {
    return `expected HTTP 200, got ${answer.status}: ${body.slice(0, 300)}`;
  }
  const processed = (JSON.parse(body) as { processed?: boolean }).processed;
  return processed === true
    ? null
    : `expected {"processed":true}, got: ${body.slice(0, 300)}`;
});

/** A refused callback must get exactly the fixed answer — nothing else. */
const expectFixedRefusal = answerCheck((answer, body) => {
  const contentType = answer.headers.get("content-type");
  return answer.status === FIXED_REFUSAL.status &&
    contentType === FIXED_REFUSAL.contentType &&
    body === FIXED_REFUSAL.body
    ? null
    : `expected the fixed refusal (${FIXED_REFUSAL.status}, ` +
        `${FIXED_REFUSAL.contentType}, "${FIXED_REFUSAL.body}"), got ` +
        `${answer.status}, ${contentType}, "${body.slice(0, 300)}"`;
});

/** The replay must have resolved to the booking that already existed — the
 * booker appears exactly once on the listing's Attendees tab. */
const assertStillBookedOnce = async (
  session: BrowserSession,
): Promise<void> => {
  const attendees = await assertBookedInAdmin(session);
  const bookings = attendees.split(config.bookerEmail).length - 1;
  if (bookings !== 1) {
    throw new Error(
      "SumUp replayed callback: expected exactly 1 booking for " +
        `${config.bookerEmail} on the Attendees tab, found ${bookings}`,
    );
  }
};

/**
 * Post the staged checkout's own callback (twice — SumUp redelivers), then
 * probe the refusal contract with ids the app must turn away unread.
 */
export const assertSumupCallbackContract = async (
  session: BrowserSession,
  ctx: HostedCheckoutContext,
): Promise<void> => {
  step("Exercising the SumUp callback contract (self-delivered)");
  const sumupId = await readLoggedId(
    ctx.serverLogPath,
    SUMUP_ID_LINE.pattern,
    SUMUP_ID_LINE.expected,
  );

  await expectProcessed(
    await postCallback(ctx.baseUrl, sumupId),
    "genuine callback",
  );
  log("  ✔ genuine callback ran the observation path and was processed");

  await expectProcessed(
    await postCallback(ctx.baseUrl, sumupId),
    "replayed callback",
  );
  await assertStillBookedOnce(session);
  log("  ✔ replayed callback resolved to the same single booking");

  const readsBefore = countLogMatches(ctx.serverLogPath, CHECKOUT_READ_LINES);
  const refusalsBefore = countLogMatches(ctx.serverLogPath, REFUSAL_LINES);
  await expectFixedRefusal(
    await postCallback(ctx.baseUrl, `co_forged_${crypto.randomUUID()}`),
    "forged id",
  );
  await expectFixedRefusal(
    await postCallback(ctx.baseUrl, "x".repeat(256)),
    "oversized id",
  );
  await expectFixedRefusal(await postCallback(ctx.baseUrl, ""), "empty id");
  await expectFixedRefusal(await postCallback(ctx.baseUrl), "missing id");

  // Refusals must be free: four new refusal lines prove the probes took the
  // fixed retryable path, and zero new read lines prove none of them made the
  // app reach out to SumUp (the staged-row pre-filter's whole point). The
  // lines travel stdout → pipe → log file after the HTTP answer, so poll for
  // the flush rather than reading back immediately; the probes were answered
  // one at a time, so once the fourth refusal is visible, any read line they
  // caused is visible too.
  const flushed = await pollUntil(10_000, () => {
    const seen =
      countLogMatches(ctx.serverLogPath, REFUSAL_LINES) - refusalsBefore;
    return Promise.resolve(seen >= 4 ? seen : null);
  });
  const newRefusals =
    flushed ??
    countLogMatches(ctx.serverLogPath, REFUSAL_LINES) - refusalsBefore;
  const newReads =
    countLogMatches(ctx.serverLogPath, CHECKOUT_READ_LINES) - readsBefore;
  if (newReads !== 0 || newRefusals !== 4) {
    throw new Error(
      "SumUp refusal probes: expected 4 new refusal log lines and 0 new " +
        `checkout-read lines, got ${newRefusals} refusal(s) and ` +
        `${newReads} read(s)`,
    );
  }
  log(
    "  ✔ forged, oversized, empty, and missing ids all took the one fixed refusal without a SumUp read",
  );
};
