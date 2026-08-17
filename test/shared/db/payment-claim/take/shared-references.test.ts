import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, requireOne } from "#shared/db/client.ts";
import { claimAttendeeRows } from "#shared/db/payment-claim/take.ts";
import {
  type StoredPaymentReference,
  storePaymentReference,
} from "#shared/db/payment-reference-store.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { historicalPaymentReferenceStorage } from "#test-utils/historical-payment-references.ts";
import {
  claimCurrentAttendeeRows,
  heldSessionIds,
} from "#test-utils/payment-claim.ts";
import { getCompleteRefundPaymentReferencesForAttendee } from "#test-utils/payment-references.ts";
import {
  bookedWithPayment,
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

const repointPaymentRow = async (
  sessionId: string,
  stored: StoredPaymentReference,
): Promise<void> => {
  await execute(
    `UPDATE processed_payments
        SET payment_reference = ?, payment_reference_index = ?
      WHERE payment_session_id = ?`,
    [stored.encrypted, stored.index, sessionId],
  );
};

const sharedSessions = (claim: {
  shared: ReadonlyMap<string, readonly { sessionId: string }[]>;
}): string[] =>
  [...claim.shared.values()]
    .flat()
    .map(({ sessionId }) => sessionId)
    .sort();

const UNREADABLE_ROW_STATE = "not-an-encrypted-payment-state";
const FIRST_REFUSED_SHARING_ROW_COUNT = 101;

const addUnreadableSharingRows = async (
  sourceSessionId: string,
  attendeeId: number,
): Promise<void> => {
  await execute(
    `WITH RECURSIVE sharingRow(row_number) AS (
       VALUES (1)
       UNION ALL
       SELECT row_number + 1
         FROM sharingRow
        WHERE row_number < ?
     )
     INSERT INTO processed_payments (
       payment_session_id, attendee_id, processed_at, failure_data,
       payment_reference, payment_reference_index
     )
     SELECT 'sess-overflow-' || sharingRow.row_number, ?,
            source.processed_at, ?, source.payment_reference,
            source.payment_reference_index
       FROM sharingRow
       JOIN processed_payments AS source
         ON source.payment_session_id = ?`,
    [
      FIRST_REFUSED_SHARING_ROW_COUNT,
      attendeeId,
      UNREADABLE_ROW_STATE,
      sourceSessionId,
    ],
  );
};

describeWithEnv(
  "db > taking a payment claim > shared payment references",
  { db: true, encryptionKey: true },
  () => {
    test("two rows on one attendee expose one shared representation", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-same-attendee-a",
        "pi_same_attendee",
      );
      await finalizeProcessedPayment(
        "sess-same-attendee-b",
        attendeeId,
        "tok-b",
        taggedPaymentReference("pi_same_attendee"),
      );

      const held = await claimCurrentAttendeeRows([attendeeId]);

      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect(sharedSessions(held)).toEqual([
        "sess-same-attendee-a",
        "sess-same-attendee-b",
      ]);
    });

    test("a tagged reference claims its matching old untagged holder", async () => {
      const tagged = await bookedWithPayment("sess-alias-tagged", "pi_alias");
      await bookedWithPayment("sess-alias-untagged", "temporary_alias");
      const old = await historicalPaymentReferenceStorage("pi_alias");
      await repointPaymentRow("sess-alias-untagged", old);

      const held = await claimCurrentAttendeeRows([tagged]);

      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect(heldSessionIds(held).sort()).toEqual([
        "sess-alias-tagged",
        "sess-alias-untagged",
      ]);
      expect(sharedSessions(held)).toEqual([
        "sess-alias-tagged",
        "sess-alias-untagged",
      ]);
    });

    test("known providers sharing raw text remain separate identities", async () => {
      const stripe = await bookedWithPayment(
        "sess-provider-stripe",
        "same_provider_text",
      );
      const square = await bookedWithPayment(
        "sess-provider-square",
        "temporary_square_text",
      );
      const storedSquare = await storePaymentReference(
        taggedPaymentReference("same_provider_text", "square"),
      );
      await repointPaymentRow("sess-provider-square", storedSquare);

      const stripeHeld = await claimCurrentAttendeeRows([stripe]);
      const squareHeld = await claimCurrentAttendeeRows([square]);

      if (stripeHeld.kind !== "claimed" || squareHeld.kind !== "claimed") {
        throw new Error("the distinct provider claims were refused");
      }
      expect(heldSessionIds(stripeHeld)).toEqual(["sess-provider-stripe"]);
      expect(heldSessionIds(squareHeld)).toEqual(["sess-provider-square"]);
      expect(stripeHeld.shared).toEqual(new Map());
      expect(squareHeld.shared).toEqual(new Map());
    });

    test("a blank matching index is a separator, never a lookup slot", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-index-separator",
        "pi_index_separator",
      );
      const attendee = await requireOne<{ pii_blob: string }>(
        "SELECT pii_blob FROM attendees WHERE id = ?",
        [attendeeId],
      );
      const references = await getCompleteRefundPaymentReferencesForAttendee({
        currentPaymentId: "pi_index_separator",
        id: attendeeId,
      });
      const matchingIndexCount = new Set(
        references.flatMap(({ matchingIndexes }) => matchingIndexes),
      ).size;

      const { queries, result } = await runWithQueryLogContext(async () => {
        enableQueryLog();
        const result = await claimAttendeeRows([
          {
            attendeeId,
            loadedPiiBlob: attendee.pii_blob,
            references: references.map((reference) => ({
              ...reference,
              matchingIndexes: [...reference.matchingIndexes, ""],
            })),
          },
        ]);
        return { queries: getQueryLog().map(({ sql }) => sql), result };
      });

      expect(result).toMatchObject({ kind: "claimed" });
      const sharingQuery = queries.find((sql) =>
        sql.includes("attendee_id NOT IN"),
      );
      if (sharingQuery === undefined) {
        throw new Error("The shared-reference lookup did not run");
      }
      expect(sharingQuery.match(/\?/g) ?? []).toHaveLength(
        1 + matchingIndexCount,
      );
    });

    test("an attendee with no references skips the sharing lookup", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-no-reference",
        "pi_no_reference",
      );
      await execute(
        "DELETE FROM processed_payments WHERE payment_session_id = ?",
        ["sess-no-reference"],
      );

      const { queries, result } = await runWithQueryLogContext(async () => {
        enableQueryLog();
        const result = await claimCurrentAttendeeRows([attendeeId]);
        return { queries: getQueryLog().map(({ sql }) => sql), result };
      });

      expect(result).toMatchObject({ kind: "claimed" });
      expect(queries.some((sql) => sql.includes("attendee_id NOT IN"))).toBe(
        false,
      );
    });

    test("refuses excessive sharing rows before decrypting their state", async () => {
      const sourceSessionId = "sess-overflow-source";
      const source = await bookedWithPayment(
        sourceSessionId,
        "pi_overflow_source",
      );
      const sharing = await bookedWithPayment(
        "sess-overflow-holder",
        "pi_overflow_holder",
      );
      await addUnreadableSharingRows(sourceSessionId, sharing);

      const { queries, result } = await runWithQueryLogContext(async () => {
        enableQueryLog();
        const result = await claimCurrentAttendeeRows([source]);
        return { queries: getQueryLog().map(({ sql }) => sql), result };
      });

      expect(result).toEqual({ kind: "too_many_reference_holders" });
      expect(
        queries.find((sql) => sql.includes("attendee_id NOT IN")),
      ).toContain(`LIMIT ${FIRST_REFUSED_SHARING_ROW_COUNT}`);
      const state = await execute(
        `SELECT COUNT(*) AS row_count,
                SUM(CASE WHEN protected_state != '' THEN 1 ELSE 0 END)
                  AS claimed_count,
                SUM(CASE WHEN failure_data = ? THEN 1 ELSE 0 END)
                  AS unreadable_count
           FROM processed_payments
          WHERE payment_reference_index = (
            SELECT payment_reference_index
              FROM processed_payments
             WHERE payment_session_id = ?
          )`,
        [UNREADABLE_ROW_STATE, sourceSessionId],
      );
      expect(state.rows[0]).toMatchObject({
        claimed_count: 0,
        row_count: FIRST_REFUSED_SHARING_ROW_COUNT + 1,
        unreadable_count: FIRST_REFUSED_SHARING_ROW_COUNT,
      });
    });
  },
);
