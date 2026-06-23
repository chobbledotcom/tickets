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
        args: ["7", "attendee", "3"],
        sql: "UPDATE transfers SET source_id = ? WHERE source_type = ? AND source_id = ?",
      },
      {
        args: ["7", "attendee", "3"],
        sql: "UPDATE transfers SET dest_id = ? WHERE dest_type = ? AND dest_id = ?",
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
});
