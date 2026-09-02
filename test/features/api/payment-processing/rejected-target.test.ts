import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { SessionRejection } from "#payment/validated-session.ts";
import { answerRejectedSession } from "#routes/api/payment-processing/rejected-target.ts";
import { runWithPendingWork } from "#shared/pending-work.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { requestAsSession } from "#test-utils/session.ts";

/** A checkout we cannot even name a charge for: the answer needs no money
 *  work, so the test stays on the page the branch renders. */
const blankReference = (): SessionRejection => ({
  provider: "sumup",
  reason: "blank_reference",
  sessionId: "cs_blank",
});

describeWithEnv("the rejected-checkout answer", { db: true }, () => {
  test("tells the buyer the session could not be found", async () => {
    const response = await answerRejectedSession(blankReference(), () => {});

    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain("We could not find this payment session.");
    expect(page).not.toContain("Staff diagnostics");
  });

  test("hands an owner the diagnostics beside the refusal", async () => {
    const { getTestSession } = await import("#test-utils/session.ts");

    const response = await runWithPendingWork(async () =>
      answerRejectedSession(
        blankReference(),
        () => {},
        await requestAsSession("/payment/success", await getTestSession()),
      ),
    );

    const page = await response.text();
    expect(page).toContain("Staff diagnostics");
    expect(page).toContain("cs_blank");
  });
});
