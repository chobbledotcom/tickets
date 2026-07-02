import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  deleteManualLedgerEntry,
  MANUAL_ATTENDEE_CHARGE,
  MANUAL_ATTENDEE_PAYMENT,
  MANUAL_ATTENDEE_WRITEOFF,
  MANUAL_LISTING_COST,
  MANUAL_LISTING_INCOME,
  MANUAL_MODIFIER_INCOME,
  MANUAL_MODIFIER_REDUCTION,
  type ManualLedgerEntryType,
  manualLedgerEntryOptionsFor,
  postManualLedgerEntry,
  updateManualLedgerEntry,
} from "#shared/accounting/manual-entries.ts";
import { allTransfers } from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { account } from "#shared/ledger/account.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";
import { tx, useTransactionalDb } from "#test-utils/ledger.ts";

const world = account("external", "world");
const writeoff = account("writeoff", "default");

type ManualEntryCase = {
  type: ManualLedgerEntryType;
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
      updateManualLedgerEntry(transfer!, -1, transfer!.occurredAt),
    ).rejects.toThrow("invalid transfer update");
  });

  test("offers each account type ONLY its own entry options", () => {
    // The option filter keys on the spec table's accountType; an inverted
    // match would offer listing entries on an attendee account.
    const offered = manualLedgerEntryOptionsFor(account("attendee", 1)).map(
      (option) => option.type,
    );
    expect(offered).toEqual([
      MANUAL_ATTENDEE_PAYMENT,
      MANUAL_ATTENDEE_CHARGE,
      MANUAL_ATTENDEE_WRITEOFF,
    ]);
    expect(
      manualLedgerEntryOptionsFor(account("revenue", 1)).map((o) => o.type),
    ).toEqual([MANUAL_LISTING_INCOME, MANUAL_LISTING_COST]);
  });

  test("updates an owner-entered entry's amount and business time", async () => {
    await postManualLedgerEntry({
      account: account("attendee", 1),
      amount: 100,
      occurredAt: "2026-06-22T09:30:00.000Z",
      postedBy: "1",
      type: MANUAL_ATTENDEE_PAYMENT,
    });
    const [before] = await allTransfers();

    await updateManualLedgerEntry(before!, 250, "2026-06-23T10:00:00.000Z");

    const [after] = await allTransfers();
    expect(after!.amount).toBe(250);
    expect(after!.occurredAt).toBe("2026-06-23T10:00:00.000Z");
    // Identity and provenance are untouched by an amount/time edit.
    expect(after!.id).toBe(before!.id);
    expect(after!.reference).toBe(before!.reference);
  });

  test("deletes an owner-entered entry", async () => {
    await postManualLedgerEntry({
      account: account("attendee", 1),
      amount: 100,
      occurredAt: "2026-06-22T09:30:00.000Z",
      postedBy: "1",
      type: MANUAL_ATTENDEE_PAYMENT,
    });
    const [entry] = await allTransfers();
    await deleteManualLedgerEntry(entry!);
    expect(await allTransfers()).toEqual([]);
  });

  /** Post one checkout-history leg (a `sale`) and read back its stored row. */
  const storedSaleLeg = async (): Promise<Transfer> => {
    await postTransfers([tx({ kind: "sale", reference: "sale-guard" })]);
    return (await allTransfers())[0]!;
  };

  test("refuses to edit a checkout-event transfer, leaving it untouched", async () => {
    const sale = await storedSaleLeg();
    await expect(
      updateManualLedgerEntry(sale, 999, sale.occurredAt),
    ).rejects.toThrow("not an owner-entered ledger entry");
    expect((await allTransfers())[0]!.amount).toBe(sale.amount);
  });

  test("refuses to delete a checkout-event transfer, leaving it stored", async () => {
    const sale = await storedSaleLeg();
    await expect(deleteManualLedgerEntry(sale)).rejects.toThrow(
      "not an owner-entered ledger entry",
    );
    expect(await allTransfers()).toHaveLength(1);
  });
});
