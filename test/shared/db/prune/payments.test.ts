import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { PRUNE_PAYMENTS_RETENTION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  insertClaimedPayment,
  insertFailedPayment,
  insertFinalizedPayment,
  insertOrphanAttendee,
  insertUnfinalizedPayment,
  paymentExists,
  postRefundCash,
} from "./helpers.ts";

const oldEnoughToPrune = () =>
  new Date(nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000).toISOString();

const insertOldReferencedPayment = async (sessionId: string) => {
  const attendeeId = await insertOrphanAttendee(
    new Date(nowMs()).toISOString(),
  );
  await insertFinalizedPayment(sessionId, oldEnoughToPrune(), {
    attendeeId,
    paymentReference: "encrypted-reference",
  });
  return attendeeId;
};

describeWithEnv("db > prunePayments", { db: true }, () => {
  test("deletes old finalized payments with no useful refund reference", async () => {
    await insertFinalizedPayment("sess_old", oldEnoughToPrune());

    await runDatabasePruning();

    expect(await paymentExists("sess_old")).toBe(false);
  });

  test("keeps old finalized payments while their refund reference is useful", async () => {
    await insertOldReferencedPayment("sess_refund_useful");

    await runDatabasePruning();

    expect(await paymentExists("sess_refund_useful")).toBe(true);
  });

  test("deletes old finalized payments once the attendee is refunded", async () => {
    const attendeeId = await insertOldReferencedPayment("sess_refund_done");
    await postRefundCash(attendeeId);

    await runDatabasePruning();

    expect(await paymentExists("sess_refund_done")).toBe(false);
  });

  test("keeps finalized payments within retention window", async () => {
    const recent = new Date(nowMs() - 1000).toISOString();
    await insertFinalizedPayment("sess_recent", recent);

    await runDatabasePruning();

    expect(await paymentExists("sess_recent")).toBe(true);
  });

  test("leaves unfinalized reservations alone regardless of age", async () => {
    await insertUnfinalizedPayment("sess_unfinalized", oldEnoughToPrune());

    await runDatabasePruning();

    expect(await paymentExists("sess_unfinalized")).toBe(true);
  });

  test("deletes recorded terminal failures older than retention window", async () => {
    await insertFailedPayment("sess_failed_old", oldEnoughToPrune());

    await runDatabasePruning();

    expect(await paymentExists("sess_failed_old")).toBe(false);
  });

  test("keeps recorded terminal failures within retention window", async () => {
    const recent = new Date(nowMs() - 1000).toISOString();
    await insertFailedPayment("sess_failed_recent", recent);

    await runDatabasePruning();

    expect(await paymentExists("sess_failed_recent")).toBe(true);
  });

  test("keeps an old row a refund run is holding right now", async () => {
    await insertClaimedPayment("sess_claimed_old", oldEnoughToPrune());

    await runDatabasePruning();

    // Deleting it mid-run would throw away the claim, and a later run could
    // then pay the same money a second time.
    expect(await paymentExists("sess_claimed_old")).toBe(true);
  });
});
