import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  MANUAL_ATTENDEE_CHARGE,
  MANUAL_ATTENDEE_PAYMENT,
  MANUAL_ATTENDEE_WRITEOFF,
  MANUAL_LISTING_COST,
  MANUAL_LISTING_INCOME,
  MANUAL_MODIFIER_INCOME,
  MANUAL_MODIFIER_REDUCTION,
  postManualLedgerEntry,
  updateTransferAmountAndTime,
} from "#shared/accounting/manual-entries.ts";
import { allTransfers } from "#shared/accounting/queries.ts";
import { account } from "#shared/ledger/account.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import { useTransactionalDb } from "#test-utils/ledger.ts";

const world = account("external", "world");
const writeoff = account("writeoff", "default");

type ManualEntryCase = {
  type:
    | typeof MANUAL_ATTENDEE_PAYMENT
    | typeof MANUAL_ATTENDEE_CHARGE
    | typeof MANUAL_ATTENDEE_WRITEOFF
    | typeof MANUAL_LISTING_INCOME
    | typeof MANUAL_LISTING_COST
    | typeof MANUAL_MODIFIER_INCOME
    | typeof MANUAL_MODIFIER_REDUCTION;
  account: AccountRef;
  source: AccountRef;
  destination: AccountRef;
};

describe("db > accounting > manual ledger entries", () => {
  useTransactionalDb();

  test("posts each owner-entered entry type to the expected ledger legs", async () => {
    const attendee = account("attendee", 1);
    const revenue = account("revenue", 2);
    const modifier = account("modifier", 3);
    const cases: ManualEntryCase[] = [
      {
        account: attendee,
        destination: attendee,
        source: world,
        type: MANUAL_ATTENDEE_PAYMENT,
      },
      {
        account: attendee,
        destination: writeoff,
        source: attendee,
        type: MANUAL_ATTENDEE_CHARGE,
      },
      {
        account: attendee,
        destination: attendee,
        source: writeoff,
        type: MANUAL_ATTENDEE_WRITEOFF,
      },
      {
        account: revenue,
        destination: revenue,
        source: world,
        type: MANUAL_LISTING_INCOME,
      },
      {
        account: revenue,
        destination: world,
        source: revenue,
        type: MANUAL_LISTING_COST,
      },
      {
        account: modifier,
        destination: modifier,
        source: writeoff,
        type: MANUAL_MODIFIER_INCOME,
      },
      {
        account: modifier,
        destination: writeoff,
        source: modifier,
        type: MANUAL_MODIFIER_REDUCTION,
      },
    ];

    for (const [index, entry] of cases.entries()) {
      await postManualLedgerEntry({
        account: entry.account,
        amount: 100 + index,
        occurredAt: "2026-06-22T09:30:00.000Z",
        postedBy: "1",
        type: entry.type,
      });
    }

    const rowsByKind = Object.fromEntries(
      (await allTransfers()).map((transfer) => [transfer.kind, transfer]),
    );
    for (const [index, entry] of cases.entries()) {
      expect(rowsByKind[entry.type]?.amount).toBe(100 + index);
      expect(rowsByKind[entry.type]?.source).toEqual(entry.source);
      expect(rowsByKind[entry.type]?.destination).toEqual(entry.destination);
    }
  });

  test("rejects an entry type that does not belong to the account", async () => {
    await expect(
      postManualLedgerEntry({
        account: account("attendee", 1),
        amount: 100,
        occurredAt: "2026-06-22T09:30:00.000Z",
        postedBy: "1",
        type: MANUAL_LISTING_COST,
      }),
    ).rejects.toThrow("is not valid for attendee");
    expect(await allTransfers()).toEqual([]);
  });

  test("rejects an edit that would make the transfer invalid", async () => {
    await postManualLedgerEntry({
      account: account("attendee", 1),
      amount: 100,
      occurredAt: "2026-06-22T09:30:00.000Z",
      postedBy: "1",
      type: MANUAL_ATTENDEE_PAYMENT,
    });
    const [transfer] = await allTransfers();

    await expect(
      updateTransferAmountAndTime(transfer!, -1, transfer!.occurredAt),
    ).rejects.toThrow("invalid transfer update");
  });
});
