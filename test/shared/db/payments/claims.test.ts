import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch, getDb } from "#shared/db/client.ts";
import {
  applyPaymentSessionClaim,
  applyPaymentSessionClaimKeepingLease,
  claimPaymentSession,
  paymentFulfilmentStatements,
  releasePaymentSessionClaim,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import { createPaymentSession } from "#shared/db/payments/sessions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  PAYMENT_BOOKING_COMPLETION,
  PAYMENT_ID,
  PAYMENT_TIME,
  paymentSessionInput,
  READY_RESULT,
  sessionProgress,
} from "./fixtures.ts";

const requiredClaim = async () => {
  const claim = await claimPaymentSession(PAYMENT_ID, 60_000);
  if (claim === null) throw new Error("Expected to claim the payment session");
  return claim;
};

describeWithEnv("db > payments > claims", { db: true }, () => {
  test("requires a positive lease duration", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    await expect(claimPaymentSession(PAYMENT_ID, 0)).rejects.toThrow();
  });

  test("requires the payment to be available for a claim", async () => {
    await expect(
      requirePaymentSessionClaim("missing-payment", 60_000),
    ).rejects.toThrow("Could not claim payment session missing-payment");
  });

  test("gives one concurrent worker the payment lease", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    const claims = await Promise.all([
      claimPaymentSession(PAYMENT_ID, 60_000),
      claimPaymentSession(PAYMENT_ID, 60_000),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });

  test("reclaims an expired lease without deleting the session", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    const first = await claimPaymentSession(PAYMENT_ID, 60_000);
    await getDb().execute(
      "UPDATE payment_sessions SET lease_expires_at = 0 WHERE id = ?",
      [PAYMENT_ID],
    );

    const second = await claimPaymentSession(PAYMENT_ID, 60_000);

    expect(second?.leaseToken).not.toBe(first?.leaseToken);
    const rows = await getDb().execute(
      "SELECT COUNT(*) AS count FROM payment_sessions WHERE id = ?",
      [PAYMENT_ID],
    );
    expect(Number(rows.rows[0]?.count)).toBe(1);
  });

  test("rejects release and apply from a stale lease token", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    const first = await requiredClaim();
    await getDb().execute(
      "UPDATE payment_sessions SET lease_expires_at = 0 WHERE id = ?",
      [PAYMENT_ID],
    );
    await claimPaymentSession(PAYMENT_ID, 60_000);

    await expect(
      releasePaymentSessionClaim(first, PAYMENT_TIME + 120_000),
    ).rejects.toThrow(`Lost payment session lease for ${PAYMENT_ID}`);
    await expect(
      applyPaymentSessionClaim(first, sessionProgress()),
    ).rejects.toThrow(`Lost payment session lease for ${PAYMENT_ID}`);
  });

  test("releases a claim with its next reconcile time", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    const claim = await requiredClaim();

    await releasePaymentSessionClaim(claim, PAYMENT_TIME + 120_000);

    const row = await getDb().execute(
      "SELECT lease_token, next_reconcile_at, revision FROM payment_sessions WHERE id = ?",
      [PAYMENT_ID],
    );
    expect(row.rows[0]).toEqual({
      lease_token: null,
      next_reconcile_at: PAYMENT_TIME + 120_000,
      revision: 3,
    });

    const nextClaim = await claimPaymentSession(PAYMENT_ID, 60_000);
    if (nextClaim === null)
      throw new Error("Expected the released payment claim");
    await releasePaymentSessionClaim(nextClaim, 0);
    const immediate = await getDb().execute(
      "SELECT next_reconcile_at FROM payment_sessions WHERE id = ?",
      [PAYMENT_ID],
    );
    expect(immediate.rows[0]?.next_reconcile_at).toBe(0);
  });

  test("applies encrypted result, ticket, and completion progress once", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    const claim = await requiredClaim();
    const session = await applyPaymentSessionClaim(
      claim,
      sessionProgress({
        attendeeId: 42,
        completion: PAYMENT_BOOKING_COMPLETION,
        completionState: "pending",
        result: READY_RESULT,
        resultState: "succeeded",
        state: "ready",
        ticketState: "ready",
        ticketTokens: ["ticket-one", "ticket-two"],
      }),
    );

    expect(session.state).toBe("ready");
    expect(session.result).toEqual(READY_RESULT);
    expect(session.ticketTokens).toEqual(["ticket-one", "ticket-two"]);
    expect(session.completion).toEqual(PAYMENT_BOOKING_COMPLETION);
    expect(session.leaseExpiresAt).toBeNull();
  });

  test("rejects a forbidden lifecycle transition before writing", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    const claim = await requiredClaim();

    await expect(
      applyPaymentSessionClaim(claim, sessionProgress({ state: "completed" })),
    ).rejects.toThrow("cannot change from created to completed");
  });

  test("rolls back fulfilment from a stale owner", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    const first = await requiredClaim();
    const processing = await applyPaymentSessionClaimKeepingLease(
      first,
      sessionProgress({
        result: READY_RESULT,
        resultState: "succeeded",
        state: "processing",
      }),
    );
    await getDb().execute(
      "UPDATE payment_sessions SET lease_expires_at = 0 WHERE id = ?",
      [PAYMENT_ID],
    );
    const replacement = await requiredClaim();
    const statements = await paymentFulfilmentStatements(
      processing.claim,
      processing.payment,
      "?",
      [42],
      ["stale-ticket"],
      PAYMENT_BOOKING_COMPLETION,
    );

    await expect(executeBatch(statements)).rejects.toThrow();

    const row = await getDb().execute(
      `SELECT attendee_id, ticket_tokens, lease_token
         FROM payment_sessions WHERE id = ?`,
      [PAYMENT_ID],
    );
    expect(row.rows[0]).toEqual({
      attendee_id: null,
      lease_token: replacement.leaseToken,
      ticket_tokens: null,
    });
  });

  test("keeps the aggregate open when a business guard no longer matches", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    const claim = await requiredClaim();
    const processing = await applyPaymentSessionClaimKeepingLease(
      claim,
      sessionProgress({
        result: READY_RESULT,
        resultState: "succeeded",
        state: "processing",
      }),
    );
    const statements = await paymentFulfilmentStatements(
      processing.claim,
      processing.payment,
      "?",
      [42],
      ["guarded-ticket"],
      PAYMENT_BOOKING_COMPLETION,
      { args: [1], sql: "0 = ?" },
    );

    await executeBatch(statements);

    const row = await getDb().execute(
      `SELECT attendee_id, ticket_tokens, lease_token
         FROM payment_sessions WHERE id = ?`,
      [PAYMENT_ID],
    );
    expect(row.rows[0]).toEqual({
      attendee_id: null,
      lease_token: processing.claim.leaseToken,
      ticket_tokens: null,
    });
  });
});
