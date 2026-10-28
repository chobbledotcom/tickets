/** Tests for the answer one admission's write gives, the direct suite
 * beside admissionAnswer in src/routes/admin/scan-reply.ts: what a door
 * reads when another door took its tickets first, and the delivery claims
 * that make the answer name a tier and quantity a prior send put in.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import { claimScanOperation } from "#db/processed-scan-operations.ts";
import type { ScanDecision } from "#routes/admin/scan-decision.ts";
import { admissionAnswer } from "#routes/admin/scan-reply.ts";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testTokenEntry } from "#test-utils/factories.ts";

/** One booking row on the door's Standard listing, holding `quantity`
 * places with `checkedIn` already admitted. */
const standardRow = (quantity: number, checkedIn = 0): TokenEntry =>
  testTokenEntry({
    attendee: {
      checked_in: checkedIn,
      id: 7,
      quantity,
      refunded: false,
    },
    listing: {
      id: 1,
      name: "Standard",
      non_transferable: false,
      purchase_only: false,
    },
  });

/** One booking row on the door's Society listing, for an entry the
 * delivery's claim does not name. */
const societyRow = (): TokenEntry =>
  testTokenEntry({
    attendee: { checked_in: 0, id: 7, quantity: 1, refunded: false },
    listing: {
      id: 2,
      name: "Society",
      non_transferable: false,
      purchase_only: false,
    },
  });

/** A full admit decision over the given rows, the shape the write's
 * answer reads. */
const admitOf = (
  rows: readonly TokenEntry[],
): Extract<ScanDecision, { kind: "admit" }> => ({
  kind: "admit",
  remaining: 0,
  rows: [...rows],
  units: [{ rows: [...rows], tickets: 1 }],
});

describeWithEnv("the answer for one admission's write", { db: true }, () => {
  test("a write that took nothing answers already checked in over the planned rows", async () => {
    // Another door took every ticket between the decision and the write.
    const answer = await admissionAnswer(
      {
        allEntries: [standardRow(1)],
        decision: admitOf([standardRow(1)]),
        delivery: undefined,
      },
      "Cara",
      { admitted: 0, remaining: 0 },
    );

    expect(await answer.json()).toEqual({
      listingName: "Standard",
      name: "Cara",
      quantity: 1,
      status: "already_checked_in",
      total: 1,
    });
  });

  test("a drained delivery answers the tier and quantity its own claim stored", async () => {
    // The delivery claimed its tier inside the write that moved nothing.
    // The answer reads that claim, so the device reads the tier and the
    // quantity the first send put in — never a fresh decision's pick — and
    // the person the claim does not name drops out of the answer.
    await withTransaction((tx) =>
      claimScanOperation({
        listingIds: [1],
        operationId: "op-drained-1",
        quantity: 2,
        tokenHash: "digest-drained-1",
      })(tx),
    );

    const answer = await admissionAnswer(
      {
        allEntries: [standardRow(3), societyRow()],
        decision: admitOf([standardRow(3)]),
        delivery: {
          operationId: "op-drained-1",
          tokenHash: "digest-drained-1",
        },
      },
      "Cara",
      { admitted: 0, remaining: 0 },
    );

    expect(await answer.json()).toEqual({
      listingName: "Standard",
      name: "Cara",
      quantity: 2,
      status: "already_checked_in",
      total: 3,
    });
  });

  test("a delivery that named more than its landing admitted still alerts", async () => {
    // The delivery named five people, the booking held three, and the write
    // moved none because another door took them first. The claim stands at
    // the three the delivery planned, so the answer reads that landing, and
    // it still says the numbers: the first send's answer can get lost
    // before it reaches the door.
    await withTransaction((tx) =>
      claimScanOperation({
        listingIds: [1],
        operationId: "op-over-admitted-1",
        quantity: 3,
        tokenHash: "digest-over-admitted-1",
      })(tx),
    );

    const answer = await admissionAnswer(
      {
        allEntries: [standardRow(3), societyRow()],
        decision: admitOf([standardRow(3)]),
        delivery: {
          operationId: "op-over-admitted-1",
          quantity: 5,
          tokenHash: "digest-over-admitted-1",
        },
      },
      "Cara",
      { admitted: 0, remaining: 0 },
    );

    expect(await answer.json()).toEqual({
      listingName: "Standard",
      name: "Cara",
      overAdmission: { admitted: 3, bought: 4, named: 5 },
      quantity: 3,
      status: "already_checked_in",
      total: 3,
    });
  });

  test("a drained delivery whose ledger row is gone fails loudly", async () => {
    // The admission stores the pair before any drained answer reads it, so
    // a missing row is a broken invariant, not an answer.
    await expect(
      admissionAnswer(
        {
          allEntries: [standardRow(1)],
          decision: admitOf([standardRow(1)]),
          delivery: {
            operationId: "op-drained-2",
            tokenHash: "digest-drained-2",
          },
        },
        "Cara",
        { admitted: 0, remaining: 0 },
      ),
    ).rejects.toThrow(
      "A claimed scan delivery's ledger row went missing before its answer",
    );
  });

  test("a write that took tickets answers checked in with what remains", async () => {
    const answer = await admissionAnswer(
      {
        allEntries: [standardRow(3)],
        decision: admitOf([standardRow(3)]),
        delivery: undefined,
      },
      "Cara",
      { admitted: 1, remaining: 2 },
    );

    expect(await answer.json()).toEqual({
      listingName: "Standard",
      name: "Cara",
      quantity: 1,
      remaining: 2,
      status: "checked_in",
      total: 3,
    });
  });
});
