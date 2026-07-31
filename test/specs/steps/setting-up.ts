// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  browserSeenBy,
  LATECOMER,
  newcomerReading,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import {
  aSiteNobodyHasSetUp,
  firstOwnerCanSignIn,
  GOOD_PASSWORD,
  latecomerCanSignIn,
  latecomerSendsSetup,
  openingSetupAgain,
  openSetup,
  somebodySetsUp,
  whatSetterWasTold,
} from "#test/specs/support/setting-up.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given("nobody has set the site up", (): Promise<void> => aSiteNobodyHasSetUp());

Given("the site has been set up", (): void => {
  // Every scenario starts on a site the harness already set up, so this is the
  // state as given — named so the story reads for itself.
});

Then(
  "a newcomer is told the site is not ready",
  async function (this: TicketsWorld): Promise<void> {
    const { said } = await newcomerReading("/");
    expect(said).toContain(t("public.not_activated.message"));
  },
);

Then(
  "the way to set it up is there for them",
  async function (this: TicketsWorld): Promise<void> {
    const { answered, said } = await newcomerReading("/setup/");
    expect(answered).toBe(200);
    expect(said).toContain(t("setup.heading"));
  },
);

When(
  "somebody sets the site up",
  function (this: TicketsWorld): Promise<string> {
    return somebodySetsUp(this, GOOD_PASSWORD, GOOD_PASSWORD);
  },
);

When(
  "somebody sets the site up typing a different password the second time",
  function (this: TicketsWorld): Promise<string> {
    return somebodySetsUp(this, GOOD_PASSWORD, `${GOOD_PASSWORD}-oops`);
  },
);

Then("they are told the site is set up", function (this: TicketsWorld): void {
  expect(whatSetterWasTold(this)).toContain(t("setup.complete.heading"));
});

Then(
  "the owner they made can sign in",
  async function (this: TicketsWorld): Promise<void> {
    expect(await firstOwnerCanSignIn(GOOD_PASSWORD)).toBe(true);
  },
);

Then(
  "they are told the passwords do not match",
  function (this: TicketsWorld): void {
    expect(whatSetterWasTold(this)).toContain("Passwords do not match");
  },
);

Then(
  "the site is still not set up",
  async function (this: TicketsWorld): Promise<void> {
    // The refusal has to have changed nothing: a site that made the owner and
    // then complained would still be somebody else's site now.
    expect(await firstOwnerCanSignIn(GOOD_PASSWORD)).toBe(false);
    const { said } = await newcomerReading("/");
    expect(said).toContain(t("public.not_activated.message"));
  },
);

Given(
  "somebody else already had the setup page open",
  async function (this: TicketsWorld): Promise<void> {
    rememberBrowser(this, LATECOMER, await openSetup());
  },
);

When(
  "they send their setup after the site is somebody's",
  function (this: TicketsWorld): Promise<void> {
    return latecomerSendsSetup(browserSeenBy(this, LATECOMER));
  },
);

Then(
  "the site still belongs to the first owner",
  async function (this: TicketsWorld): Promise<void> {
    // Setting up again would make a second owner and replace the keys that
    // protect everybody's details, so the first owner would lose their site.
    expect(await latecomerCanSignIn()).toBe(false);
    expect(await firstOwnerCanSignIn(GOOD_PASSWORD)).toBe(true);
  },
);

Then(
  "opening the way to set it up leads away from it",
  async function (this: TicketsWorld): Promise<void> {
    const { landedOn, stillOffered } = await openingSetupAgain();
    expect(stillOffered).toBe(false);
    expect(landedOn).not.toBe("/setup");
  },
);

Then(
  "the site can still be set up afterwards",
  async function (this: TicketsWorld): Promise<void> {
    // A refusal that made the owner anyway and then stopped short would leave
    // the site unable to be set up at all — the name is taken and nobody can
    // sign in. Setting it up properly now is what proves nothing was left.
    await somebodySetsUp(this, GOOD_PASSWORD, GOOD_PASSWORD);
    expect(whatSetterWasTold(this)).toContain(t("setup.complete.heading"));
    expect(await firstOwnerCanSignIn(GOOD_PASSWORD)).toBe(true);
  },
);
