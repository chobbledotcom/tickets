import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { queryOne } from "#shared/db/client.ts";
import { paymentStoredJson } from "#shared/db/payments/codecs.ts";
import { beginPaymentDecisionAttempt } from "#shared/db/payments/decision-attempts.ts";
import { completePaymentDecisionAndResolveCase } from "#shared/db/payments/decision-completion.ts";
import {
  acceptPaymentDecision,
  getPaymentCaseDecisions,
} from "#shared/db/payments/decisions.ts";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { reviewedPaymentSnapshot } from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  oldPaymentTime,
  recordTestPaymentCase,
  redactedAt,
  seedTerminalPayment,
} from "./payment-redaction-helpers.ts";

describeWithEnv("db > resolved payment case redaction", { db: true }, () => {
  test("redacts resolved evidence while preserving its decision audit", async () => {
    const payment = await seedTerminalPayment("resolved-case");
    const observedAt = oldPaymentTime();
    const paymentCase = await recordTestPaymentCase(payment, observedAt);
    const decision = await acceptPaymentDecision(
      paymentCase.id,
      {
        actorId: 1,
        caseRevision: paymentCase.revision,
        claimedAt: observedAt,
        reason: "Keep this audit reason",
        reviewed: reviewedPaymentSnapshot("acct-redaction"),
        selection: { kind: "refund_remaining" },
      },
      {
        actorId: 1,
        caseRevision: paymentCase.revision,
        decidedAt: observedAt,
        kind: "refund_remaining",
        reason: "Keep this audit reason",
      },
    );
    const attempt = await beginPaymentDecisionAttempt(decision.id, observedAt);
    if (attempt.status !== "running")
      throw new Error("Expected decision claim");
    await completePaymentDecisionAndResolveCase(attempt.decision);

    const first = await runDatabasePruning();

    expect(first.fullBatch).toBe(true);
    expect(await redactedAt(payment.id)).toBeNull();
    const stored = await queryOne<{
      evidence: EnvKeyEncrypted;
      evidence_redacted_at: number;
    }>(
      "SELECT evidence, evidence_redacted_at FROM payment_cases WHERE id = ?",
      [paymentCase.id],
    );
    if (stored === null) throw new Error("Expected resolved payment case");
    const evidence = await paymentStoredJson.caseEvidence.open(
      stored.evidence,
      "redacted case evidence",
    );
    expect(evidence).toEqual({
      address: "",
      date: null,
      email: "",
      items: payment.intent.items,
      modifiers: [],
      name: "",
      phone: "",
      special_instructions: "",
    });
    expect(JSON.stringify(evidence)).not.toContain(payment.intent.email);
    expect(await getPaymentCaseDecisions(paymentCase.id)).toMatchObject([
      {
        claim: { reason: "Keep this audit reason" },
        decision: { reason: "Keep this audit reason" },
        state: "completed",
      },
    ]);

    await runDatabasePruning(first.checkpoint);

    expect(await redactedAt(payment.id)).not.toBeNull();
  });
});
