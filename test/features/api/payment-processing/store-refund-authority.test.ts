import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  loadPaymentMoveSnapshot,
  PaymentRowsBusyError,
} from "#shared/db/payment-admit-move.ts";
import { listProviderRefundCases } from "#shared/db/provider-refund-cases.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { protectedStateOf } from "#test-utils/payment-claim.ts";
import { statementSql, wrapDbClient } from "#test-utils/record-queries.ts";
import { withRefreshPaymentProbe } from "#test-utils/refund-routes.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import {
  reservedPlaceholder,
  storePlaceholder,
} from "./store-refund-helpers.ts";

const failNextCallbackAuthorityLookup = (): (() => void) => {
  let pending = true;
  return wrapDbClient({
    batch: () => undefined,
    execute: (statement) => {
      const sql = statementSql(statement);
      if (
        pending &&
        sql.includes("UPDATE payment_charges") &&
        sql.includes("callback_replay_index = COALESCE")
      ) {
        pending = false;
        throw new Error("refund authority lookup interrupted");
      }
      return null;
    },
  });
};

const expectPlaceholderRolledBack = async (
  placeholder: Awaited<ReturnType<typeof reservedPlaceholder>>,
): Promise<void> => {
  expect(await getAttendeesRaw(placeholder.listing.id)).toEqual([]);
  expect((await listProviderRefundCases()).cases).toEqual([]);
  expect(
    await queryOne<{ attendee_id: number | null; failure_data: string }>(
      `SELECT attendee_id, failure_data
         FROM processed_payments
        WHERE payment_session_id = ?`,
      [placeholder.data.session.id],
    ),
  ).toEqual({ attendee_id: null, failure_data: "" });
};

describeWithEnv("terminal placeholder refund authority", { db: true }, () => {
  test("rolls back the placeholder when ready authority storage fails", async () => {
    const sessionId = "cs_terminal_authority_rollback";
    const placeholder = await reservedPlaceholder(sessionId);
    await execute(
      `CREATE TRIGGER fail_placeholder_refund_authority
         BEFORE INSERT ON payment_charges
       BEGIN
         SELECT RAISE(ABORT, 'refund authority unavailable');
       END`,
    );
    try {
      await expect(storePlaceholder(placeholder)).rejects.toThrow(
        "refund authority unavailable",
      );
    } finally {
      await execute("DROP TRIGGER fail_placeholder_refund_authority");
    }

    await expectPlaceholderRolledBack(placeholder);
  });

  test("rolls back the placeholder when payment provenance cannot attach", async () => {
    const placeholder = await reservedPlaceholder(
      "cs_terminal_provenance_rollback",
    );
    await execute(
      `CREATE TRIGGER block_placeholder_payment_provenance
          AFTER INSERT ON attendees
           WHEN NEW.pii_payment_session_id IS NULL
       BEGIN
         UPDATE attendees SET pii_payment_session_id = '' WHERE id = NEW.id;
       END`,
    );
    try {
      await expect(storePlaceholder(placeholder)).rejects.toThrow(
        "could not prove its attendee payment id",
      );
    } finally {
      await execute("DROP TRIGGER block_placeholder_payment_provenance");
    }

    await expectPlaceholderRolledBack(placeholder);
  });

  test("keeps ready work when refund startup fails after terminalization", async () => {
    const sessionId = "cs_terminal_authority_interrupted";
    const placeholder = await reservedPlaceholder(sessionId);
    const restoreDb = failNextCallbackAuthorityLookup();
    try {
      await expect(storePlaceholder(placeholder)).rejects.toThrow(
        "refund authority lookup interrupted",
      );
    } finally {
      restoreDb();
    }

    const attendee = (await getAttendeesRaw(placeholder.listing.id))[0];
    if (attendee === undefined) throw new Error("placeholder was not stored");
    // The redelivery resumes the crashed tail: the refund attempt runs and
    // does not return here, so the honest pending answer comes back with the
    // resumed marker, and the ready authority stays with its recovery routes.
    expect(await processPaymentSession(sessionId, placeholder.data)).toEqual({
      detail: `Resumed after a crashed delivery of session ${sessionId}`,
      error:
        "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook. Your refund is being arranged — please contact us if it does not arrive.",
      status: 200,
      success: false,
    });

    const cases = (await listProviderRefundCases()).cases;
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ provider: "stripe", state: "ready" });

    const anchor = await queryOne<{ payment_session_id: string }>(
      `SELECT payment_session_id
         FROM processed_payments
        WHERE attendee_id = ?
          AND payment_session_id LIKE 'legacy:%'`,
      [attendee.id],
    );
    if (anchor === null) throw new Error("placeholder anchor was not stored");
    // The resume already let go of the crashed run's claim; the durable
    // ready authority, not the row fence, is what keeps the work alive.
    expect(await protectedStateOf(anchor.payment_session_id)).toBe("");

    await withRefreshPaymentProbe(
      () => Promise.resolve(false),
      async () => {
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}/refresh-payment`,
        );
        expectFlash(response, expect.stringContaining("up to date"), true);
      },
    );

    expect(await protectedStateOf(anchor.payment_session_id)).toBe("");
    expect((await loadPaymentMoveSnapshot([attendee.id])).work.status).toBe(
      "needs_provider_recovery",
    );
    await expect(deleteAttendee(attendee.id)).rejects.toBeInstanceOf(
      PaymentRowsBusyError,
    );
    expect(
      await (await adminGet(`/admin/attendees/${attendee.id}/actions`)).text(),
    ).toContain("/admin/privacy#refund-recovery");
  });
});
