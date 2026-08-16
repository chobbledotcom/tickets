/** The shared money completion is safe to run again from any point.
 *
 * A crashed delivery can leave the ghost stored with any tail of its money
 * work undone; the next run must finish exactly that tail and change nothing
 * that already happened. These tests run a full first delivery through the
 * rejected-charge flow, then drive the completion again directly and prove
 * every step held: one pair of legs, one note, one activity line, and an
 * authority that stays recorded. */

import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";
import { completePlaceholderMoney } from "#routes/api/payment-processing/placeholder-completion.ts";
import { settleRejectedCharge } from "#routes/api/payment-processing/rejected-target.ts";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { queryOne } from "#shared/db/client.ts";
import { anchorSessionId } from "#shared/db/payment-anchor/session.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { loadRefundAuthorityById } from "#shared/db/provider-refund-authority.ts";
import { placeholderRefund } from "#shared/payment/placeholder-refund.ts";
import { completedAtOf } from "#shared/payment/refund-authority-state.ts";
import { rejectedChargeReference } from "#shared/payment/validated-session.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { singleItem } from "#test-utils/factories.ts";
import {
  expectOnePairOfLegs,
  ourRejection,
  withSucceedingRefundFor,
} from "#test-utils/rejected-charge.ts";

setupTestEncryptionKey();

describeWithEnv("placeholder money completion", { db: true }, () => {
  const CAPTURED = 620;

  const storedNote = (): Promise<{
    note: EnvKeyEncrypted;
    system_name: string | null;
    total: number;
  } | null> =>
    queryOne<{
      note: EnvKeyEncrypted;
      system_name: string | null;
      total: number;
    }>(
      `SELECT note.note, note.system_name, COUNT(*) OVER () AS total
         FROM system_notes AS note
        WHERE note.entity_type = 'attendee'`,
      [],
    );

  const activityCount = async (): Promise<number> => {
    const row = await queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM activity_log WHERE attendee_id IS NOT NULL",
      [],
    );
    return Number(row?.total ?? 0);
  };

  it("running the whole completion again changes nothing", async () => {
    const listing = await createTestListing({});
    const rejection = ourRejection("pi_run_again", {
      items: singleItem(listing.id, 1, 500),
    });
    const { result } = await withSucceedingRefundFor(CAPTURED)(() =>
      settleRejectedCharge(rejection),
    );
    const receipt = result.returned!.authority;
    const authority = await loadRefundAuthorityById(receipt.id);
    const spec = placeholderRefund("malformed_charge")(
      `Provider reported session ${rejection.sessionId} in a form the site could not read`,
    );
    const referenceIndex = await paymentReferenceIndex(
      rejectedChargeReference(rejection),
    );

    // The first delivery finished everything: one note, named, saying the
    // money was refunded — the wording the buyer-facing books rely on.
    const first = await storedNote();
    expect(first?.total).toBe(1);
    expect(first?.system_name).not.toBeNull();
    expect(await decrypt(first!.note)).toContain(
      "but its payment was refunded because",
    );
    expect(await activityCount()).toBe(1);

    // The durable handle a resume holds: the anchor row found through the
    // deterministic reference index names the attendee.
    const attendeeId = Number(
      (
        await queryOne<{ attendee_id: number }>(
          "SELECT attendee_id FROM processed_payments WHERE payment_reference_index = ?",
          [referenceIndex],
        )
      )?.attendee_id,
    );
    await completePlaceholderMoney({
      activityMessage: `Automatic refund (${spec.code}); rejected payment kept at quantity 0`,
      amount: CAPTURED,
      attendeeId,
      dueAuthority: receipt,
      listingId: listing.id,
      occurredAt: new Date(completedAtOf(authority!.state)!).toISOString(),
      onLedgerMiss: "throw",
      referenceIndexes: [referenceIndex],
      sessionId: rejection.sessionId,
      settlement: {
        commandId: "resumed-run",
        heldSince: "2026-08-16T12:00:00.000Z",
        rows: new Map([
          [
            anchorSessionId(attendeeId, referenceIndex),
            { claim: "release", phase: "checking" },
          ],
        ]),
      },
      spec,
    });

    // Nothing moved twice: legs, note, activity, and the authority's local
    // recording (its stale receipt is tolerated because the end state is
    // already recorded) all stayed exactly as the first delivery left them.
    await expectOnePairOfLegs(rejection.sessionId);
    const again = await storedNote();
    expect(again?.total).toBe(1);
    expect(await activityCount()).toBe(1);
    const after = await loadRefundAuthorityById(receipt.id);
    expect(after?.state.kind).toBe("completed");
    expect(after?.state.local.kind).toBe("recorded");
  });
});
