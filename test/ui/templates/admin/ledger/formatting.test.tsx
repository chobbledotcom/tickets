import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  ATTENDEE,
  COST,
  EXTERNAL,
  MODIFIER,
  REVENUE,
} from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { account } from "#shared/ledger/account.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import {
  humanAmount,
  humanDescription,
  shownFigure,
  transferEventLabel,
} from "#templates/admin/ledger/formatting.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

import { transfer } from "./helpers.ts";

/** Renders one description, naming each account by its own type. */
const describeTransfer = (over: Parameters<typeof transfer>[0]): string =>
  String(
    humanDescription(transfer(over), (ref: AccountRef) => <b>{ref.type}</b>),
  );

describe("admin ledger formatting", () => {
  beforeAll(setupAdminPageTest);

  describe("transferEventLabel", () => {
    test("names a kind the ledger knows", () => {
      expect(transferEventLabel(transfer({ kind: KIND.sale }))).toBe(
        "Booking made",
      );
    });

    test("refuses to make user copy out of a kind it does not know", () => {
      expect(transferEventLabel(transfer({ kind: "invented" }))).toBe(
        "Other money change",
      );
    });

    test("names a transfer with no kind at all", () => {
      expect(transferEventLabel(transfer({ kind: "" }))).toBe("No event type");
    });
  });

  describe("humanDescription for a service cost", () => {
    test("reads as cost added when the money came out of the cost account", () => {
      const html = describeTransfer({
        destination: account(REVENUE, 1),
        kind: KIND.serviceCost,
        source: account(COST, 3),
      });
      expect(html).toContain("Service event cost added for");
    });

    test("reads as cost reduced when the money went back into it", () => {
      const html = describeTransfer({
        destination: account(COST, 3),
        kind: KIND.serviceCost,
        source: account(EXTERNAL, 1),
      });
      expect(html).toContain("Service event cost reduced for");
    });

    test("names the cost account either way", () => {
      const html = describeTransfer({
        destination: account(COST, 3),
        kind: KIND.serviceCost,
        source: account(EXTERNAL, 1),
      });
      expect(html).toContain("<b>cost</b>");
    });
  });

  describe("humanDescription for a modifier", () => {
    test("reads as an increase when the money went to the modifier", () => {
      const html = describeTransfer({
        destination: account(MODIFIER, 2),
        kind: KIND.modifier,
        source: account(ATTENDEE, 1),
      });
      expect(html).toContain("Extra option income added for");
    });

    test("reads as a reduction when the money came back off it", () => {
      const html = describeTransfer({
        destination: account(ATTENDEE, 1),
        kind: KIND.modifier,
        source: account(MODIFIER, 2),
      });
      expect(html).toContain("Option income reduced for");
    });
  });

  describe("humanAmount", () => {
    test("shows a service cost as money going out", () => {
      const out = humanAmount(
        transfer({
          amount: 900,
          destination: account(REVENUE, 1),
          kind: KIND.serviceCost,
          source: account(COST, 3),
        }),
      );
      expect(out).toBe(-900);
    });

    test("shows a modifier that raised the price as a rise", () => {
      expect(
        humanAmount(
          transfer({
            amount: 250,
            destination: account(MODIFIER, 2),
            kind: KIND.modifier,
            source: account(ATTENDEE, 1),
          }),
        ),
      ).toBe(250);
    });
  });

  describe("shownFigure", () => {
    test("turns an attendee's debt around, so it reads the way people expect", () => {
      expect(shownFigure(500, account(ATTENDEE, 1))).toBe(-500);
    });

    test("turns a servicing cost around too", () => {
      expect(shownFigure(500, account(COST, 1))).toBe(-500);
    });

    test("leaves every other account's figure alone", () => {
      expect(shownFigure(500, account(REVENUE, 1))).toBe(500);
    });

    test("leaves zero as zero rather than showing minus nothing", () => {
      expect(Object.is(shownFigure(0, account(ATTENDEE, 1)), 0)).toBe(true);
    });
  });
});
