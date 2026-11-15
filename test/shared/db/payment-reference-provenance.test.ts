import { expect } from "@std/expect";
import { test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { getRefundAllSummary } from "#db/refund-all-candidates.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookLegacyPaidAttendee,
  provenancePointerOf,
  rebuildStatingProviderForEveryRow,
  seedHistoricalProcessedPayment,
} from "#test-utils/historical-payment-references.ts";

/** What one rebuild run reports: the rows it rebuilt, the rows it could not,
 *  and the attendees left unqualified. */
type RebuildTally = {
  rebuilt: number;
  remaining: number;
  unqualifiedAttendees: number;
};

/** Assert what the rebuild reports and the pointer it leaves on the attendee. */
const expectRebuild = async (
  attendeeId: number,
  tally: RebuildTally,
  pointer: string | null,
): Promise<void> => {
  expect(await rebuildStatingProviderForEveryRow("stripe")).toEqual(tally);
  expect(await provenancePointerOf(attendeeId)).toBe(pointer);
};

/** Blank one session's reference index, as a row written before the column
 *  held it does. */
const blankReferenceIndex = async (sessionId: string): Promise<void> => {
  await execute(
    sql`UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ${sessionId}`,
  );
};

/** Date one session's payment, so row order and PII order can disagree. */
const setProcessedAt = async (sessionId: string, at: string): Promise<void> => {
  await execute(
    sql`UPDATE processed_payments SET processed_at = ${at} WHERE payment_session_id = ${sessionId}`,
  );
};

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
    await blankReferenceIndex("sess_balance");
    await setProcessedAt("sess_deposit", "2026-07-02T00:00:00.000Z");
    await setProcessedAt("sess_balance", "2026-07-01T00:00:00.000Z");

    // The attendee is qualified by the row that matches its PII payment, so
    // the older balance row it also owns leaves nobody unqualified.
    await expectRebuild(
      attendee.id,
      { rebuilt: 2, remaining: 0, unqualifiedAttendees: 0 },
      "sess_deposit",
    );
  });

  test("a later balance row alone leaves the attendee unqualified", async () => {
    const { attendee, listing } = await bookLegacyPaidAttendee(
      "sess_original",
      "pi_original",
    );
    // The PII payment predates the reference column, so only the balance row
    // is rebuildable - and it is not the payment the PII names.
    await execute(
      sql`UPDATE processed_payments SET payment_reference = '' WHERE payment_session_id = ${"sess_original"}`,
    );
    await seedHistoricalProcessedPayment(
      "sess_balance_only",
      attendee.id,
      "pi_balance_only",
    );
    await blankReferenceIndex("sess_balance_only");

    await expectRebuild(
      attendee.id,
      { rebuilt: 1, remaining: 0, unqualifiedAttendees: 1 },
      null,
    );
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
    await execute(
      sql`UPDATE attendees SET pii_blob = '' WHERE id = ${attendee.id}`,
    );

    await expectRebuild(
      attendee.id,
      { rebuilt: 1, remaining: 0, unqualifiedAttendees: 1 },
      null,
    );
  });

  test("an attendee already pointed by earlier work is not counted again", async () => {
    const { attendee } = await bookLegacyPaidAttendee(
      "sess_pointed_early",
      "pi_pointed_early",
    );
    await seedHistoricalProcessedPayment("sess_later", attendee.id, "pi_later");
    await blankReferenceIndex("sess_later");
    await execute(
      sql`UPDATE attendees SET pii_payment_session_id = ${"sess_pointed_early"} WHERE id = ${attendee.id}`,
    );

    // The later row matches no PII payment, but this attendee was never
    // unqualified, so the run must not tell the owner it still needs the
    // provider dashboard.
    await expectRebuild(
      attendee.id,
      { rebuilt: 2, remaining: 0, unqualifiedAttendees: 0 },
      "sess_pointed_early",
    );
  });
});
