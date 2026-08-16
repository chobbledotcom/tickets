/** A redelivery finishes whatever tail a crashed keep-and-refund delivery
 * left open — the refund itself, the money records, or only the stored
 * words — exactly once, from durable rows alone. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { businessTime } from "#routes/api/payment-processing/metadata.ts";
import { completePlaceholderMoney } from "#routes/api/payment-processing/placeholder-completion.ts";
import {
  findHeldAnchor,
  settlementForHeldClaim,
} from "#routes/api/payment-processing/placeholder-resume.ts";
import { requestSessionRefund } from "#routes/api/payment-processing/refunds.ts";
import { bookingEventGroup } from "#shared/accounting/mappers.ts";
import { transfersByEventGroup } from "#shared/accounting/queries.ts";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { prepareClaimedAttendeePaymentAnchor } from "#shared/db/payment-anchor/attendee.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { placeholderRefund } from "#shared/payment/placeholder-refund.ts";
import { readRowState } from "#shared/payment/row-state.ts";
import { paidPaymentReferenceOf } from "#shared/payment/validated-session.ts";
import { requireValue } from "#shared/required-value.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { taggedPaymentReference } from "#test-utils/processed-payments.ts";
import { withRefundLedgerFault } from "#test-utils/refund-ledger-fault.ts";
import { refundCompletes, withRefundMock } from "#test-utils/refund-routes.ts";
import { expectOnePairOfLegs } from "#test-utils/rejected-charge.ts";
import {
  crashedPlaceholderStore,
  type reservedPlaceholder,
} from "./store-refund-helpers.ts";

/* jscpd:ignore-end */

const REFUNDED_ANSWER =
  "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook.";

describeWithEnv("resuming a crashed placeholder delivery", { db: true }, () => {
  const heldAnchorRow = async () => {
    const row = await queryOne<{
      failure_data: EnvKeyEncrypted | "";
      payment_session_id: string;
      protected_state: string;
    }>(
      `SELECT failure_data, payment_session_id, protected_state
         FROM processed_payments WHERE payment_reference_index != ''`,
    );
    if (row === null || row.failure_data === "") {
      throw new Error("the crashed store left no held anchor row");
    }
    return { ...row, failure_data: row.failure_data };
  };

  /** The anchor row's one-word mirror: "" once every piece of work is done. */
  const anchorMirror = async (): Promise<string | null> => {
    const row = await queryOne<{ protected_state: string }>(
      "SELECT protected_state FROM processed_payments WHERE payment_reference_index != ''",
    );
    return row === null ? null : row.protected_state;
  };

  const noteCount = async (): Promise<number> => {
    const row = await queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM system_notes WHERE entity_type = 'attendee'",
    );
    return Number(row?.total ?? 0);
  };

  const chargeState = () =>
    queryOne<{ refund_local_state: string; refund_state_name: string }>(
      "SELECT refund_local_state, refund_state_name FROM payment_charges",
    );

  /** The held anchor row's stored claim, with the facts the tests rebuild
   * their commands from. */
  const heldClaim = async () => {
    const anchor = await heldAnchorRow();
    const claim = requireValue(
      readRowState(await decrypt(anchor.failure_data), "held claim").claim,
      "the anchor row holds no claim",
    );
    return { anchorSessionId: anchor.payment_session_id, claim };
  };

  /** Run the manufacture steps a crashed delivery would have finished: send
   * the refund, then the completion — with whatever settlement the scenario
   * needs — leaving the stored outcome pending. */
  const finishMoneyByHand = async (
    placeholder: Awaited<ReturnType<typeof reservedPlaceholder>>,
    settlement: Parameters<typeof completePlaceholderMoney>[0]["settlement"],
    onLedgerMiss: "throw" | "mark_unrecorded" = "throw",
  ) =>
    await withRefundMock(refundCompletes, async () => {
      const session = placeholder.data.session;
      const sent = await requestSessionRefund(session);
      if (sent.kind !== "returned" || sent.local !== "due") {
        throw new Error("manufactured refund did not return");
      }
      const { claim } = await heldClaim();
      await completePlaceholderMoney({
        activityMessage:
          "Automatic refund (capacity_full); booking kept at quantity 0",
        amount: session.amountTotal,
        attendeeId: requireValue(
          claim.attendeeIds[0],
          "the held claim names no attendee",
        ),
        dueAuthority: sent.authority,
        listingId: placeholder.listing.id,
        occurredAt: businessTime(session),
        onLedgerMiss,
        referenceIndexes: [
          await paymentReferenceIndex(paidPaymentReferenceOf(session)),
        ],
        sessionId: session.id,
        settlement,
        spec: placeholderRefund("capacity_full")("listing full"),
      });
    });

  /** The settlement the crashed run's own claim would use. */
  const rebuiltSettlement = async () => {
    const held = await heldClaim();
    return settlementForHeldClaim(held.anchorSessionId, held.claim);
  };

  test("a redelivery finishes the refund a crashed delivery never sent", async () => {
    const sessionId = "cs_resume_send";
    const placeholder = await crashedPlaceholderStore(sessionId);

    let answer: unknown;
    await withRefundMock(refundCompletes, async () => {
      answer = await processPaymentSession(sessionId, placeholder.data);
    });

    expect(answer).toEqual({
      detail: `Resumed after a crashed delivery of session ${sessionId}`,
      error: REFUNDED_ANSWER,
      refunded: true,
      status: 200,
      success: false,
    });
    await expectOnePairOfLegs(sessionId);
    expect(await chargeState()).toEqual({
      refund_local_state: "recorded",
      refund_state_name: "completed",
    });
    expect(await noteCount()).toBe(1);
    expect(await anchorMirror()).toBe("");

    // The advanced outcome replays as the plain final answer from now on.
    expect(await processPaymentSession(sessionId, placeholder.data)).toEqual({
      error: REFUNDED_ANSWER,
      refunded: true,
      status: 200,
      success: false,
    });
    expect(await noteCount()).toBe(1);
  });

  test("a redelivery lets go of a claim whose money work all landed", async () => {
    const sessionId = "cs_resume_release";
    const placeholder = await crashedPlaceholderStore(sessionId);
    // The crashed run got everything done except the release: its settle
    // carried a stranger's command id, so the claim is still on the row.
    await finishMoneyByHand(placeholder, {
      commandId: "not-the-holder",
      heldSince: "2026-08-16T12:00:00.000Z",
      rows: new Map([
        ["cs_resume_release", { claim: "release", phase: "checking" }],
      ]),
    });
    expect(await anchorMirror()).toBe("claim");

    const answer = await processPaymentSession(sessionId, placeholder.data);

    expect(answer).toEqual({
      detail: `Resumed after a crashed delivery of session ${sessionId}`,
      error: REFUNDED_ANSWER,
      refunded: true,
      status: 200,
      success: false,
    });
    // Nothing landed twice; the claim is gone and the words are final.
    await expectOnePairOfLegs(sessionId);
    expect(await noteCount()).toBe(1);
    expect(await chargeState()).toEqual({
      refund_local_state: "recorded",
      refund_state_name: "completed",
    });
    expect(await heldAnchorRow().catch(() => null)).toBeNull();
  });

  test("keeps the books' truth when a ledger miss lost only the final words", async () => {
    const sessionId = "cs_resume_unrecorded_words";
    const placeholder = await crashedPlaceholderStore(sessionId);
    // The crashed run sent the refund and hit a ledger fault: the row was
    // settled saying "unrecorded" and the claim released, but the delivery
    // died before the final words were stored.
    await withRefundLedgerFault(async () =>
      finishMoneyByHand(
        placeholder,
        await rebuiltSettlement(),
        "mark_unrecorded",
      ),
    );
    expect(await anchorMirror()).toBe("unrecorded");

    const answer = await processPaymentSession(sessionId, placeholder.data);

    // The provider really returned the money, so the words advance to the
    // refunded answer — the same one an uncrashed ledger-miss delivery
    // gives — while the row keeps saying the books are behind and the
    // authority stays due, both pointing at the refresh route.
    expect(answer).toEqual({
      error: REFUNDED_ANSWER,
      refunded: true,
      status: 200,
      success: false,
    });
    expect(await anchorMirror()).toBe("unrecorded");
    expect(await chargeState()).toEqual({
      refund_local_state: "due",
      refund_state_name: "completed",
    });
    expect(await noteCount()).toBe(0);
    expect(
      await transfersByEventGroup(await bookingEventGroup(sessionId)),
    ).toEqual([]);
  });

  test("a redelivery mends only the final words when everything else finished", async () => {
    const sessionId = "cs_resume_words";
    const placeholder = await crashedPlaceholderStore(sessionId);
    await finishMoneyByHand(placeholder, await rebuiltSettlement());
    expect(await heldAnchorRow().catch(() => null)).toBeNull();

    const answer = await processPaymentSession(sessionId, placeholder.data);

    // No live work was left, so the resume only advanced the stored words.
    expect(answer).toEqual({
      error: REFUNDED_ANSWER,
      refunded: true,
      status: 200,
      success: false,
    });
    await expectOnePairOfLegs(sessionId);
    expect(await noteCount()).toBe(1);
    expect(await processPaymentSession(sessionId, placeholder.data)).toEqual({
      error: REFUNDED_ANSWER,
      refunded: true,
      status: 200,
      success: false,
    });
  });

  describe("findHeldAnchor", () => {
    test("refuses to pick between two held anchors for one payment", async () => {
      const listing = await createTestListing({ maxAttendees: 20 });
      const payment = taggedPaymentReference("pi_two_anchors");
      for (const email of ["one@example.com", "two@example.com"]) {
        const made = await bookAttendee(listing, { email, name: "Holder" });
        if (!made.success) throw new Error("attendee setup failed");
        const prepared = await prepareClaimedAttendeePaymentAnchor(payment);
        const anchor = await prepared.forAttendee(made.attendees[0]!.id);
        await execute(anchor.statement.sql, anchor.statement.args);
      }

      const search = await findHeldAnchor(payment, "cs_two_anchors");

      expect(search.held).toBeNull();
      expect(search.rows).toHaveLength(2);
    });
  });
});
