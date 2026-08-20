import { readFileSync } from "node:fs";
import { config } from "#e2e/config.ts";
import { log } from "#e2e/log.ts";
import { pollUntil } from "#e2e/util.ts";
import { readLoggedId } from "./shared.ts";

/**
 * SumUp's unsigned callback contract, exercised against the real sandbox.
 *
 * SumUp's own webhook delivery cannot be awaited deterministically (it retries
 * a handful of times over hours), so the harness SELF-DELIVERS the same
 * callback SumUp would send — the tiny `{ event_type, id }` body carrying the
 * REAL sandbox checkout id — and the app walks its whole observation path on
 * genuine data: the staged-row pre-filter, the live re-fetch from SumUp, the
 * classifier, and the sealed-row open, resolving the already-booked checkout
 * without double-booking it. This proves the callback handling, not SumUp's
 * eventual delivery.
 *
 * Forged, oversized, empty, and missing ids must all take the one fixed
 * refusal — identical status, header, and body — so an unsigned forger learns
 * nothing from the answer's shape, and must do so without costing a SumUp
 * read.
 */

/** The one answer every locally refused callback gets, byte for byte. */
export const FIXED_REFUSAL = {
  body: "Payment verification failed",
  contentType: "text/plain; charset=utf-8",
  status: 503,
} as const;

/** The id line createCheckout logs once the staged row carries the SumUp id. */
const SUMUP_ID_LINE = {
  expected: "[SumUp] Checkout created id=…",
  pattern: "\\[SumUp\\] Checkout created id=(\\S+)",
} as const;

/** Server-log lines that show what a callback cost. The app writes
 * "[SumUp] Checkout read …" whenever a read reached out to SumUp and failed
 * (src/shared/sumup.ts — a forged id that slipped past the pre-filter would
 * show up here as a 404), and one "SumUp callback refused retryably" line per
 * refused callback (src/shared/sumup-provider.ts). */
const CHECKOUT_READ_LINES = /\[SumUp\] Checkout read /g;
const REFUSAL_LINES = /\[Webhook\] SumUp callback refused retryably/g;

/** Where the callbacks go and what they cost, for this scenario's app. */
export interface SumupCallbackTarget {
  baseUrl: string;
  serverLogPath: string;
}

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

/** This scenario's genuine checkout id, from its fresh app log. */
export const sumupCheckoutId = async (
  target: SumupCallbackTarget,
): Promise<string> =>
  await readLoggedId(
    target.serverLogPath,
    SUMUP_ID_LINE.pattern,
    SUMUP_ID_LINE.expected,
  );

/**
 * Deliver the staged checkout's own callback twice (SumUp redelivers) and
 * return the genuine checkout id used. Each delivery must be acknowledged as
 * processed.
 */
export const deliverGenuineCallbackTwice = async (
  target: SumupCallbackTarget,
): Promise<string> => {
  const sumupId = await sumupCheckoutId(target);
  await expectProcessed(
    await postCallback(target.baseUrl, sumupId),
    "genuine callback",
  );
  log("  ✔ genuine callback ran the observation path and was processed");
  await expectProcessed(
    await postCallback(target.baseUrl, sumupId),
    "replayed callback",
  );
  log("  ✔ replayed callback resolved to the same single booking");
  return sumupId;
};

/** What the four refusal probes observed, for the steps to assert on. */
export interface RefusalProbeReport {
  answers: { status: number; contentType: string | null; body: string }[];
  newReads: number;
  newRefusals: number;
}

/**
 * Deliver the four refusal probes — a forged UUID-shaped id, an oversized
 * one, an empty one, and a body with no id field at all — and report what
 * each answer was, plus how many refusal and SumUp-read log lines they cost.
 * The caller asserts the contract; this only observes.
 */
export const deliverRefusalProbes = async (
  target: SumupCallbackTarget,
): Promise<RefusalProbeReport> => {
  const readsBefore = countLogMatches(
    target.serverLogPath,
    CHECKOUT_READ_LINES,
  );
  const refusalsBefore = countLogMatches(target.serverLogPath, REFUSAL_LINES);
  const probes: { id?: string; what: string }[] = [
    { id: `co_forged_${crypto.randomUUID()}`, what: "forged id" },
    { id: "x".repeat(256), what: "oversized id" },
    { id: "", what: "empty id" },
    { what: "missing id" },
  ];
  const answers: RefusalProbeReport["answers"] = [];
  for (const probe of probes) {
    const response = await postCallback(target.baseUrl, probe.id);
    answers.push({
      body: await response.text(),
      contentType: response.headers.get("content-type"),
      status: response.status,
    });
  }

  // The refusal lines travel stdout → pipe → log file after the HTTP answer,
  // so poll for the flush rather than reading back immediately; the probes
  // were answered one at a time, so once the fourth refusal is visible, any
  // read line they caused is visible too.
  const flushed = await pollUntil(10_000, () => {
    const seen =
      countLogMatches(target.serverLogPath, REFUSAL_LINES) - refusalsBefore;
    return Promise.resolve(seen >= 4 ? seen : null);
  });
  const newRefusals =
    flushed ??
    countLogMatches(target.serverLogPath, REFUSAL_LINES) - refusalsBefore;
  const newReads =
    countLogMatches(target.serverLogPath, CHECKOUT_READ_LINES) - readsBefore;
  return { answers, newReads, newRefusals };
};
