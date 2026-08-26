// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { ORGANISER } from "#test/specs/support/browser.ts";
import {
  howManyMaySignIn,
  type InvitedStaffRole,
  inviteLinkIn,
  ownerOpensWhoMaySignIn,
  ownerSendsInviteForm,
  rowForPersonOnList,
} from "#test/specs/support/staff-accounts.ts";
import {
  keepWhatTheyWereTold,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { TEST_ADMIN_USERNAME } from "#test-utils/internal.ts";

// jscpd:ignore-end

/** A role the story names, checked against the ones the site has. A story that
 * invented one would otherwise be sent to a form that cannot offer it, and the
 * failure would name a missing dropdown rather than the made-up word. */
const roleNamed = (role: string): InvitedStaffRole => {
  if (role === "editor" || role === "manager") return role;
  throw new Error(`The site has no such role as "${role}"`);
};

Given(
  "the owner invites {word} as a/an {word}",
  async function (
    this: TicketsWorld,
    who: string,
    role: string,
  ): Promise<void> {
    keepWhatTheyWereTold(
      this,
      ORGANISER,
      await ownerSendsInviteForm(this, who, roleNamed(role)),
    );
  },
);

When(
  "the owner looks at who may sign in",
  function (this: TicketsWorld): Promise<void> {
    return ownerOpensWhoMaySignIn(this);
  },
);

Then(
  "the owner is given a link to send {word}",
  function (this: TicketsWorld, _who: string): void {
    expect(inviteLinkIn(whatTheyWereTold(this, ORGANISER))).not.toBeNull();
  },
);

Then(
  "the owner is told how long that link lasts",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("users.invite_expires"),
    );
  },
);

Then(
  "the list says {word} is a/an {word} who has not joined yet",
  function (this: TicketsWorld, who: string, role: string): void {
    const { row } = rowForPersonOnList(this, who);
    expect(row).toContain(roleNamed(role));
    expect(row).toContain(t("users.status.invited"));
  },
);

Then("the list holds the owner as well", function (this: TicketsWorld): void {
  // The owner is on the same list as everybody else, and has joined — they
  // set their password when the site was set up.
  const { row } = rowForPersonOnList(this, TEST_ADMIN_USERNAME);
  expect(row).toContain("owner");
  expect(row).toContain(t("users.status.active"));
});

Then(
  "the owner is told that username is taken",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("error.username_taken"),
    );
  },
);

Then(
  "only the owner and {word} may sign in",
  async function (this: TicketsWorld, _who: string): Promise<void> {
    // A refused invite must leave nothing behind: an invite waiting to be used
    // already reserves a name, so counting the people is what proves it.
    expect(await howManyMaySignIn()).toBe(2);
  },
);
