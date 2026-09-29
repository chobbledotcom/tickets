// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { getRefundAllSummary } from "#db/refund-all-candidates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookLegacyPaidAttendee,
  provenancePointerOf,
  rebuildStatingProviderForEveryRow,
  seedHistoricalProcessedPayment,
} from "#test-utils/historical-payment-references.ts";

// jscpd:ignore-end

describeWithEnv("db > legacy rebuild provenance pointer", { db: true }, () => {
  test("the rebuild qualifies the attendee provenance pointer and unblocks Refund All", async () => {
    const { attendee, listing } = await bookLegacyPaidAttendee(
      "sess_provenance",
      "pi_provenance",
    );
    expect(await getRefundAllSummary(listing.id)).toEqual({
      blockedBy: "legacy_unindexed",
      total: 1,
    });

    await rebuildStatingProviderForEveryRow("stripe");

    expect(await provenancePointerOf(attendee.id)).toBe("sess_provenance");
    expect(await getRefundAllSummary(listing.id)).toEqual({
      blockedBy: null,
      total: 1,
    });
  });

  test("the pointer follows the attendee's PII payment, not the page order", async () => {
    const { attendee } = await bookLegacyPaidAttendee(
      "sess_deposit",
      "pi_deposit",
    );
    // An older balance row than the PII payment, so row order and PII disagree.
    await seedHistoricalProcessedPayment(
      "sess_balance",
      attendee.id,
      "pi_balance",
    );
    await execute(
      "UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ?",
      ["sess_balance"],
    );
    await execute(
      "UPDATE processed_payments SET processed_at = ? WHERE payment_session_id = ?",
      ["2026-07-02T00:00:00.000Z", "sess_deposit"],
    );
    await execute(
      "UPDATE processed_payments SET processed_at = ? WHERE payment_session_id = ?",
      ["2026-07-01T00:00:00.000Z", "sess_balance"],
    );

    expect(await rebuildStatingProviderForEveryRow("stripe")).toEqual({
      rebuilt: 2,
      remaining: 0,
      unqualified: 1,
    });
    expect(await provenancePointerOf(attendee.id)).toBe("sess_deposit");
  });

  test("a later balance row alone leaves the attendee unqualified", async () => {
    const { attendee, listing } = await bookLegacyPaidAttendee(
      "sess_original",
      "pi_original",
    );
    // The PII payment predates the reference column, so only the balance row
    // is rebuildable - and it is not the payment the PII names.
    await execute(
      "UPDATE processed_payments SET payment_reference = '' WHERE payment_session_id = ?",
      ["sess_original"],
    );
    await seedHistoricalProcessedPayment(
      "sess_balance_only",
      attendee.id,
      "pi_balance_only",
    );
    await execute(
      "UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ?",
      ["sess_balance_only"],
    );

    expect(await rebuildStatingProviderForEveryRow("stripe")).toEqual({
      rebuilt: 1,
      remaining: 0,
      unqualified: 1,
    });
    expect(await provenancePointerOf(attendee.id)).toBeNull();
    // The summary keeps refusing, so the owner is never offered an action the
    // refund path would reject.
    expect(await getRefundAllSummary(listing.id)).toEqual({
      blockedBy: "legacy_unindexed",
      total: 1,
    });
  });

  test("an attendee with no readable PII keeps its pointer unset", async () => {
    const { attendee } = await bookLegacyPaidAttendee(
      "sess_no_pii",
      "pi_no_pii",
    );
    await execute("UPDATE attendees SET pii_blob = '' WHERE id = ?", [
      attendee.id,
    ]);

    expect(await rebuildStatingProviderForEveryRow("stripe")).toEqual({
      rebuilt: 1,
      remaining: 0,
      unqualified: 1,
    });
    expect(await provenancePointerOf(attendee.id)).toBeNull();
  });
});
