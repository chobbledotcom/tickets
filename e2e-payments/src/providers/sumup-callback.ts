import type { BrowserSession } from "#e2e/browser.ts";
import { log, step } from "#e2e/log.ts";
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
 * Forged, oversized, and blank ids must all take the one fixed refusal —
 * identical status, header, and body — so an unsigned forger learns nothing
 * from the answer's shape and never costs a SumUp call.
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

/** Deliver a SumUp-shaped callback to the app; `id` omitted sends a blank. */
const postCallback = (baseUrl: string, id?: string): Promise<Response> =>
  fetch(`${baseUrl}/payment/webhook`, {
    body: JSON.stringify({
      event_type: "CHECKOUT_STATUS_CHANGED",
      ...(id === undefined ? {} : { id }),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
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

/**
 * Post the staged checkout's own callback (twice — SumUp redelivers), then
 * probe the refusal contract with ids the app must turn away unread.
 */
export const assertSumupCallbackContract = async (
  _session: BrowserSession,
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
  log("  ✔ replayed callback resolved to the same booking");

  await expectFixedRefusal(
    await postCallback(ctx.baseUrl, `co_forged_${crypto.randomUUID()}`),
    "forged id",
  );
  await expectFixedRefusal(
    await postCallback(ctx.baseUrl, "x".repeat(256)),
    "oversized id",
  );
  await expectFixedRefusal(await postCallback(ctx.baseUrl), "blank id");
  log("  ✔ forged, oversized, and blank ids all took the one fixed refusal");
};
