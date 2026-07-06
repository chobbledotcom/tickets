import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { repointAttendeeStatements } from "#shared/accounting/repoint.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { executeBatch } from "#shared/db/client.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { describeWithEnv } from "#test-utils";

describe("accounting > repoint > repointAttendeeStatements", () => {
  test("builds source- and dest-id updates scoped to the attendee account", () => {
    expect(repointAttendeeStatements(3, 7)).toEqual([
      {
        args: ["7", "3", "attendee"],
        sql: "UPDATE transfers SET source_id = ? WHERE source_id = ? AND source_type = ?",
      },
      {
        args: ["7", "3", "attendee"],
        sql: "UPDATE transfers SET dest_id = ? WHERE dest_id = ? AND dest_type = ?",
      },
    ]);
  });
});

/** A paid booking on one attendee: sale (attendee→revenue) + payment. */
const booking = (attendeeId: number): TransferInput[] => [
  {
    amount: 5000,
    destination: revenueAccount(1),
    eventGroup: "evt",
    kind: "sale",
    occurredAt: "2026-06-21T00:00:00.000Z",
    reference: "sale",
    source: attendeeAccount(attendeeId),
  },
  {
    amount: 5000,
    destination: attendeeAccount(attendeeId),
    eventGroup: "evt",
    kind: "payment",
    occurredAt: "2026-06-21T00:00:00.000Z",
    reference: "pay",
    source: WORLD,
  },
];

describeWithEnv("accounting > repoint (integration)", { db: true }, () => {
  test("moves every leg from the source attendee onto the target", async () => {
    await postTransfers(booking(3));
    await executeBatch(repointAttendeeStatements(3, 7));

    expect((await transfersByAccount(attendeeAccount(3))).length).toBe(0);
    expect((await transfersByAccount(attendeeAccount(7))).length).toBe(2);
    expect(await accountBalance(attendeeAccount(7))).toBe(0); // still paid in full
    expect(await accountBalance(revenueAccount(1))).toBe(5000); // revenue untouched
  });

  test("is a no-op for a source with no ledger rows", async () => {
    await executeBatch(repointAttendeeStatements(3, 7));
    expect((await transfersByAccount(attendeeAccount(7))).length).toBe(0);
  });

  test("leaves rows of another account type with the same numeric id untouched", async () => {
    // Revenue account 3 shares the source attendee's numeric id — only the
    // type+id pair may move, so a repoint of attendee 3 must not steal it.
    await postTransfers([
      {
        amount: 5000,
        destination: revenueAccount(3),
        eventGroup: "evt-type",
        kind: "sale",
        occurredAt: "2026-06-21T00:00:00.000Z",
        reference: "sale-type",
        source: attendeeAccount(3),
      },
    ]);

    await executeBatch(repointAttendeeStatements(3, 7));

    // The sale's source leg followed the attendee…
    expect((await transfersByAccount(attendeeAccount(7))).length).toBe(1);
    expect((await transfersByAccount(attendeeAccount(3))).length).toBe(0);
    // …while its destination stayed on revenue 3 (same id, different type).
    expect(await accountBalance(revenueAccount(3))).toBe(5000);
    expect((await transfersByAccount(revenueAccount(7))).length).toBe(0);
  });
});
