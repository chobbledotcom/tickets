/**
 * Entrypoint for the email sandbox e2e run.
 *
 *   deno task e2e:email           # every provider
 *   deno task e2e:email resend    # one provider
 *
 * Runs each selected provider's leg through the production email code
 * against the provider's real API, then reports per leg. Unlike the payment
 * harness, a missing on-switch secret skips that leg and reports the skip:
 * operators enable exactly the legs they hold credentials for. A configured
 * leg the provider refuses fails the run.
 *
 * Exit codes: 0 = executed (legs sent or skipped), 1 = failed.
 */

import { failRun, runHarness } from "#e2e/entry.ts";
import { log, step, warn } from "#e2e/log.ts";
import { failureNotifier } from "#e2e/notify.ts";
import {
  appendStepSummary,
  publishExecutedResult,
} from "#scripts/github-actions.ts";
import { parseEmailTarget } from "./legs.ts";
import {
  emailSummaryMarkdown,
  everyLegSkipped,
  failedProviders,
  outcomeLine,
  sentCount,
} from "./report.ts";
import { type EmailLegOutcome, runEmailLeg } from "./run.ts";

const requestedTarget = (): string => process.argv[2] ?? "all";

const notifyEmailFailure = failureNotifier("email sandbox e2e");

const run = async (): Promise<void> => {
  const providers = parseEmailTarget(requestedTarget());
  step(`Email sandbox e2e — target: ${requestedTarget()}`);

  const outcomes: EmailLegOutcome[] = [];
  for (const provider of providers) {
    step(`Leg: ${provider}`);
    const outcome = await runEmailLeg(provider);
    log(outcomeLine(outcome));
    outcomes.push(outcome);
  }

  appendStepSummary(emailSummaryMarkdown(outcomes));
  if (everyLegSkipped(outcomes)) {
    warn("every leg was skipped — no provider on-switch secret is set");
  }

  const failed = failedProviders(outcomes);
  if (failed.length > 0) {
    await failRun(`FAIL — ${failed.join(", ")}: see the leg lines above`, () =>
      notifyEmailFailure(requestedTarget()),
    );
    return;
  }
  log("RESULT: executed");
  publishExecutedResult();
  step(
    `PASS — ${sentCount(outcomes)} leg(s) sent, ${
      outcomes.length - sentCount(outcomes)
    } skipped`,
  );
};

runHarness(run, () => notifyEmailFailure(requestedTarget())).then(() =>
  // A provider socket a timed-out leg left stalled must not hold the
  // finished process open, so leave explicitly once the report is out.
  process.exit(),
);
