/**
 * The owner removing a person's access: the typed name that proves which
 * person is meant, and what a removal — or a refusal — leaves behind.
 */

// jscpd:ignore-start
import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { ORGANISER } from "#test/specs/support/browser.ts";
import {
  ownerTakesDown,
  rowAddressFor,
} from "#test/specs/support/removing-access.ts";
import {
  managerBrowser,
  staffMemberCanSignIn,
} from "#test/specs/support/staff-accounts.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The refusal when the typed name is not the person's. The full wording is
 * built where every confirmed removal builds it,
 * src/features/admin/confirmation.ts; the words before the explanation are
 * what this step reads. */
const DOES_NOT_MATCH = "Username does not match";

When(
  "the owner tries to remove {word}, typing {word} to confirm",
  async function (
    this: TicketsWorld,
    who: string,
    typed: string,
  ): Promise<void> {
    await ownerTakesDown(this, who, typed);
  },
);

When(
  "the owner removes {word}, typing {word} to confirm",
  async function (
    this: TicketsWorld,
    who: string,
    typed: string,
  ): Promise<void> {
    await ownerTakesDown(this, who, typed);
  },
);

Then(
  "the owner is told the username does not match",
  function (this: TicketsWorld): void {
    const told = whatTheyWereTold(this, ORGANISER);
    expect(told).toContain(DOES_NOT_MATCH);
    expect(told).not.toContain(t("success.user_deleted"));
  },
);

Then(
  "the owner is told {word} was deleted",
  function (this: TicketsWorld, _who: string): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("success.user_deleted"),
    );
  },
);

Then(
  "the Users list still offers {word}",
  async function (this: TicketsWorld, who: string): Promise<void> {
    expect(await rowAddressFor(this, who)).not.toBeNull();
  },
);

Then(
  "the Users list no longer offers {word}",
  async function (this: TicketsWorld, who: string): Promise<void> {
    expect(await rowAddressFor(this, who)).toBeNull();
  },
);

Then(
  "{word} can still sign in",
  async function (this: TicketsWorld, who: string): Promise<void> {
    expect(await staffMemberCanSignIn(who)).toBe(true);
  },
);

Then(
  "{word} cannot sign in any more",
  async function (this: TicketsWorld, who: string): Promise<void> {
    expect(await staffMemberCanSignIn(who)).toBe(false);
  },
);

Then(
  "Sam's own window is signed out",
  async function (this: TicketsWorld): Promise<void> {
    // The removal claims to end every signed-in window. Sam's own browser,
    // signed in before the removal, is the proof: opening a page he could see
    // before now lands him on the sign-in page.
    const browser = managerBrowser(this, "Sam");
    await browser.visit("/admin/attendees");
    expect(browser.pageText).toContain("Login");
  },
);
