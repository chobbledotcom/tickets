/**
 * The income ledger reader, against a fake session: the text the ledger's
 * section renders, and the "Total income earned" row parsed to minor units.
 * The row parse is what the nightly's income assertions stake their amounts
 * on, so every branch it carries is exercised here in-process.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { BrowserSession } from "#e2e/browser.ts";
import {
  incomeLedgerText,
  totalIncomeEarnedMinor,
} from "#e2e/income-ledger.ts";

/** A session whose page carries one locator: no ledger, or this text. */
const sessionWithLedger = (count: number, text: string): BrowserSession =>
  ({
    page: {
      locator: () => ({
        count: () => Promise.resolve(count),
        innerText: () => Promise.resolve(text),
      }),
    },
  }) as unknown as BrowserSession;

describe("incomeLedgerText", () => {
  test("returns null when the ledger section does not render", async () => {
    expect(await incomeLedgerText(sessionWithLedger(0, ""))).toBeNull();
  });

  test("returns the ledger's text when the section renders", async () => {
    const ledger = "Gross sales £10.00\nTotal income earned £9.00";
    expect(await incomeLedgerText(sessionWithLedger(1, ledger))).toBe(ledger);
  });
});

describe("totalIncomeEarnedMinor", () => {
  test("reads the labelled row, in minor units", () => {
    expect(
      totalIncomeEarnedMinor(
        "Gross sales £10.00\nTotal income earned £9.00\nRefunds £1.00",
      ),
    ).toBe(900);
  });

  test("keeps a negative earned figure", () => {
    expect(totalIncomeEarnedMinor("Total income earned −£9.00")).toBe(-900);
  });

  test("returns null when the ledger carries no such row", () => {
    expect(
      totalIncomeEarnedMinor("Gross sales £10.00\nRefunds £1.00"),
    ).toBeNull();
  });

  test("returns null when the labelled row carries no amount", () => {
    expect(totalIncomeEarnedMinor("Total income earned")).toBeNull();
  });

  test("returns null when the row's remainder is not an amount", () => {
    expect(totalIncomeEarnedMinor("Total income earned £9.0.0")).toBeNull();
  });
});
