import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  recordPaymentCase,
  resolvePaymentCaseRevision,
} from "#shared/db/payments/cases.ts";
import { beginPaymentDecisionAttempt } from "#shared/db/payments/decision-attempts.ts";
import { PAYMENT_DECISION_LEASE_MS } from "#shared/db/payments/decision-claim.ts";
import {
  completePaymentDecisionAndResolveCase,
  completeRefundDecisionsForPayment,
} from "#shared/db/payments/decision-completion.ts";
import {
  acceptPaymentDecision,
  getPaymentCaseDecisions,
  replaceRunningPaymentDecision,
  retryPaymentDecision,
} from "#shared/db/payments/decisions.ts";
import type {
  PaymentOperatorDecision,
  PaymentOperatorDecisionClaim,
} from "#shared/payment-state/lifecycle.ts";
import { createAcceptedRefundDecision } from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  PAYMENT_ID,
  PAYMENT_TIME,
  reviewedPaymentSnapshot,
  SESSION_RESOURCE,
} from "./fixtures.ts";

const caseObservation = {
  evidence: {
    kind: "provider_read" as const,
    read: {
      reason: "unsupported_status" as const,
      requested: SESSION_RESOURCE,
      status: "invalid" as const,
    },
  },
  nextReconcileAt: null,
  paymentId: PAYMENT_ID,
  reason: "invalid_provider_data",
  resource: SESSION_RESOURCE,
  state: "needs_action" as const,
};

const claim = (revision: number): PaymentOperatorDecisionClaim => ({
  actorId: 1,
  caseRevision: revision,
  claimedAt: PAYMENT_TIME,
  reason: "Checked the payment facts",
  reviewed: reviewedPaymentSnapshot("account-one"),
  selection: { kind: "refund_remaining" },
});

const decision = (revision: number): PaymentOperatorDecision => ({
  actorId: 1,
  caseRevision: revision,
  decidedAt: PAYMENT_TIME,
  kind: "refund_remaining",
  reason: "Checked the payment facts",
});

const paymentCaseFor = async (resourceId = SESSION_RESOURCE.id) =>
  (
    await recordPaymentCase(
      {
        ...caseObservation,
        resource: { ...SESSION_RESOURCE, id: resourceId },
      },
      PAYMENT_TIME,
    )
  ).paymentCase;

const acceptedRefundDecision = async () => {
  const { decision: accepted, paymentCase } =
    await createAcceptedRefundDecision();
  return { accepted, paymentCase };
};

describeWithEnv("db > payment case decisions", { db: true }, () => {
  test("stores the exact decision and actor facts encrypted", async () => {
    const paymentCase = await paymentCaseFor();

    const stored = await acceptPaymentDecision(
      paymentCase.id,
      claim(paymentCase.revision),
      decision(paymentCase.revision),
    );
    const raw = await getDb().execute(
      "SELECT claim, decision FROM payment_case_decisions WHERE id = ?",
      [stored.id],
    );

    expect(stored.claim.actorId).toBe(1);
    expect(stored.decision).toEqual(decision(paymentCase.revision));
    expect(String(raw.rows[0]?.claim)).toMatch(/^enc:1:/);
    expect(String(raw.rows[0]?.decision)).toMatch(/^enc:1:/);
    expect(JSON.stringify(raw.rows[0])).not.toContain(
      "Checked the payment facts",
    );
  });

  test("accepts only one concurrent decision for a revision", async () => {
    const paymentCase = await paymentCaseFor();
    const values = await Promise.allSettled([
      acceptPaymentDecision(
        paymentCase.id,
        claim(paymentCase.revision),
        decision(paymentCase.revision),
      ),
      acceptPaymentDecision(
        paymentCase.id,
        claim(paymentCase.revision),
        decision(paymentCase.revision),
      ),
    ]);

    expect(values.filter((value) => value.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = values.find((value) => value.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status !== "rejected")
      throw new Error("Expected one rejection");
    expect(rejected.reason).toMatchObject({ reason: "duplicate" });
    expect(await getPaymentCaseDecisions(paymentCase.id)).toHaveLength(1);
  });

  test("rejects a stale revision without saving a decision", async () => {
    const first = await paymentCaseFor();
    await recordPaymentCase(caseObservation, PAYMENT_TIME + 1);

    await expect(
      acceptPaymentDecision(
        first.id,
        claim(first.revision),
        decision(first.revision),
      ),
    ).rejects.toMatchObject({ reason: "stale" });
    expect(await getPaymentCaseDecisions(first.id)).toEqual([]);
  });

  test("rejects a decision after the exact case is resolved", async () => {
    const paymentCase = await paymentCaseFor();
    await resolvePaymentCaseRevision(
      paymentCase.id,
      paymentCase.revision,
      PAYMENT_TIME + 1,
    );

    await expect(
      acceptPaymentDecision(
        paymentCase.id,
        claim(paymentCase.revision),
        decision(paymentCase.revision),
      ),
    ).rejects.toMatchObject({ reason: "closed" });
  });

  test("runs, retries, and completes one saved decision", async () => {
    const { accepted, paymentCase } = await acceptedRefundDecision();

    const firstAttempt = await beginPaymentDecisionAttempt(
      accepted.id,
      PAYMENT_TIME + 1,
    );
    if (firstAttempt.status !== "running")
      throw new Error("Expected first run");
    await retryPaymentDecision(
      accepted.id,
      "The provider is still working",
      PAYMENT_TIME + 2,
    );
    const retrying = (await getPaymentCaseDecisions(paymentCase.id))[0];
    const secondAttempt = await beginPaymentDecisionAttempt(
      accepted.id,
      PAYMENT_TIME + 3,
    );
    if (secondAttempt.status !== "running")
      throw new Error("Expected second run");
    await completePaymentDecisionAndResolveCase(secondAttempt.decision);
    const completed = (await getPaymentCaseDecisions(paymentCase.id))[0];

    expect(firstAttempt.decision).toMatchObject({
      attemptCount: 1,
      state: "running",
    });
    expect(retrying).toMatchObject({
      attemptCount: 1,
      nextRetryAt: PAYMENT_TIME + 2,
      state: "retrying",
    });
    expect(secondAttempt.decision).toMatchObject({
      attemptCount: 2,
      state: "running",
    });
    expect(completed).toMatchObject({ attemptCount: 2, state: "completed" });
    expect(await beginPaymentDecisionAttempt(accepted.id)).toEqual({
      status: "completed",
    });
  });

  test("reclaims a running decision only after its bounded lease", async () => {
    const { accepted } = await acceptedRefundDecision();
    const startedAt = PAYMENT_TIME + 1;
    const first = await beginPaymentDecisionAttempt(accepted.id, startedAt);
    if (first.status !== "running")
      throw new Error("Expected a running decision");

    expect(
      await beginPaymentDecisionAttempt(
        accepted.id,
        startedAt + PAYMENT_DECISION_LEASE_MS - 1,
      ),
    ).toEqual({ status: "busy" });
    const reclaimed = await beginPaymentDecisionAttempt(
      accepted.id,
      startedAt + PAYMENT_DECISION_LEASE_MS,
    );

    expect(reclaimed).toMatchObject({
      decision: { attemptCount: 2, state: "running" },
      status: "running",
    });
  });

  test("stores exact provider facts once after a decision starts", async () => {
    const paymentCase = await paymentCaseFor();
    const providerClaim: PaymentOperatorDecisionClaim = {
      ...claim(paymentCase.revision),
      reviewed: {
        charges: [{ chargeId: 1, providerReference: "hyb:1:reference" }],
        kind: "legacy_assignment",
        paymentId: PAYMENT_ID,
      },
      selection: {
        accountId: "square-account",
        kind: "assign_provider",
        mode: "test",
        provider: "square",
      },
    };
    const exact: PaymentOperatorDecision = {
      accountId: "square-account",
      actorId: 1,
      caseRevision: paymentCase.revision,
      decidedAt: PAYMENT_TIME,
      kind: "assign_provider",
      mode: "test",
      provider: "square",
      read: null,
      reason: "Checked the payment facts",
    };
    const accepted = await acceptPaymentDecision(
      paymentCase.id,
      providerClaim,
      exact,
    );
    await getDb().execute(
      "UPDATE payment_case_decisions SET state = 'running', attempt_count = 1, last_attempt_at = ? WHERE id = ?",
      [PAYMENT_TIME + 1, accepted.id],
    );
    const withRead: PaymentOperatorDecision = {
      ...exact,
      read: { status: "missing" },
    };

    await replaceRunningPaymentDecision(accepted.id, withRead);
    expect(
      (await getPaymentCaseDecisions(paymentCase.id))[0]?.decision,
    ).toEqual(withRead);
  });

  test("rejects retry and completion outside a running decision", async () => {
    const paymentCase = await paymentCaseFor();
    const accepted = await acceptPaymentDecision(
      paymentCase.id,
      claim(paymentCase.revision),
      decision(paymentCase.revision),
    );

    await expect(
      retryPaymentDecision(accepted.id, "Not running", PAYMENT_TIME + 1),
    ).rejects.toThrow("could not be retried");
  });

  test("completes only saved refund decisions after shared refund work", async () => {
    const selections = [
      {
        exact: decision(1),
        resourceId: "refund-session",
        selection: { kind: "refund_remaining" as const },
      },
      {
        exact: {
          actorId: 1,
          caseRevision: 1,
          charges: [
            {
              captured: { amount: 1_000, currency: "GBP" },
              chargeId: 1,
            },
          ],
          decidedAt: PAYMENT_TIME,
          kind: "confirm_fully_refunded" as const,
          reason: "Checked the payment facts",
        },
        resourceId: "confirmed-session",
        selection: { kind: "confirm_fully_refunded" as const },
      },
      {
        exact: {
          actorId: 1,
          caseRevision: 1,
          decidedAt: PAYMENT_TIME,
          kind: "complete_booking" as const,
          reason: "Checked the payment facts",
        },
        resourceId: "booking-session",
        selection: { kind: "complete_booking" as const },
      },
    ];
    const saved = [];
    for (const entry of selections) {
      const paymentCase = await paymentCaseFor(entry.resourceId);
      const accepted = await acceptPaymentDecision(
        paymentCase.id,
        { ...claim(paymentCase.revision), selection: entry.selection },
        { ...entry.exact, caseRevision: paymentCase.revision },
      );
      await getDb().execute(
        "UPDATE payment_case_decisions SET state = 'running', attempt_count = 1, last_attempt_at = ? WHERE id = ?",
        [PAYMENT_TIME + 1, accepted.id],
      );
      await retryPaymentDecision(
        accepted.id,
        "Waiting for shared payment work",
        PAYMENT_TIME + 2,
      );
      saved.push({ decisionId: accepted.id, paymentCase });
    }

    await completeRefundDecisionsForPayment(PAYMENT_ID, PAYMENT_TIME + 3);

    const states = await Promise.all(
      saved.map(async ({ paymentCase }) => ({
        caseState: (
          await getDb().execute(
            "SELECT state FROM payment_cases WHERE id = ?",
            [paymentCase.id],
          )
        ).rows[0]?.state,
        decisionState: (await getPaymentCaseDecisions(paymentCase.id))[0]
          ?.state,
      })),
    );
    expect(states).toEqual([
      { caseState: "resolved", decisionState: "completed" },
      { caseState: "resolved", decisionState: "completed" },
      { caseState: "needs_action", decisionState: "retrying" },
    ]);
  });
});
