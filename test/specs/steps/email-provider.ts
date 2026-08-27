// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { ORGANISER } from "#test/specs/support/browser.ts";
import {
  fromAddressTheBoxShows,
  howTheSiteSends,
  KEY_ALREADY_GIVEN,
  offersATestSend,
  ownerConnects,
  ownerHasABusinessEmail,
  ownerOpensAdvancedSettings,
  ownerSendsATestEmail,
  providerTheBoxShows,
  providerWillAnswer,
  settingsCopy,
  siteAlreadySendsThrough,
} from "#test/specs/support/email-provider.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { activityMessages } from "#test-utils/activity-log.ts";

// jscpd:ignore-end

/** The key a story's owner types when it is connecting for the first time. */
const KEY_TYPED_NOW = "re_key_typed_now";

Given(
  "the site sends through {string} from {string}",
  (provider: string, from: string): Promise<void> =>
    siteAlreadySendsThrough(provider, from),
);

Given(
  "the owner has a business email",
  (): Promise<void> => ownerHasABusinessEmail(),
);

/** A site that can really send: a provider to send through, and somewhere for
 * the test to land. */
Given("the site can send email to the owner", async (): Promise<void> => {
  await siteAlreadySendsThrough("resend", "from@example.com");
  await ownerHasABusinessEmail();
});

Given(
  "the provider refuses with {int} and says {string}",
  function (this: TicketsWorld, status: number, said: string): void {
    providerWillAnswer(this, new Response(said, { status }));
  },
);

Given(
  "the provider refuses with {int} and says nothing",
  function (this: TicketsWorld, status: number): void {
    providerWillAnswer(this, new Response(null, { status }));
  },
);

Given(
  "sendgrid refuses with {int}, explaining {string}",
  function (this: TicketsWorld, status: number, said: string): void {
    // SendGrid wraps its reason in its own envelope. The site has to dig the
    // sentence out of it, which is the whole point of this scenario.
    providerWillAnswer(
      this,
      new Response(
        JSON.stringify({ errors: [{ field: "from", message: said }] }),
        {
          status,
        },
      ),
    );
  },
);

Given("the provider never answers", function (this: TicketsWorld): void {
  providerWillAnswer(this, new Error("Network error"));
});

When(
  "the owner opens their advanced settings",
  function (this: TicketsWorld): Promise<void> {
    return ownerOpensAdvancedSettings(this);
  },
);

When(
  "the owner connects {string} sending from {string}",
  function (this: TicketsWorld, provider: string, from: string): Promise<void> {
    return ownerConnects(this, { from, key: KEY_TYPED_NOW, provider });
  },
);

When(
  "the owner changes the provider to {string}, filling nothing else in",
  function (this: TicketsWorld, provider: string): Promise<void> {
    // Only the provider. Naming the other boxes would send what this step
    // chose rather than what the page put in them, and the route ignores an
    // empty from-address, so the send would prove nothing about either.
    return ownerConnects(this, { provider });
  },
);

When(
  "the owner chooses no provider at all",
  function (this: TicketsWorld): Promise<void> {
    return ownerConnects(this, { provider: "" });
  },
);

When(
  "the owner sends a test email",
  function (this: TicketsWorld): Promise<void> {
    return ownerSendsATestEmail(this);
  },
);

Then(
  "the page offers to connect an email provider",
  async function (this: TicketsWorld): Promise<void> {
    const page = whatTheyWereTold(this, ORGANISER);
    // The section named, and every box it offers. A heading with no form
    // under it is a page that says the site can send email and cannot.
    expect(page).toContain(
      await settingsCopy("settings.advanced.email_notifications"),
    );
    for (const label of [
      "settings.advanced.email_provider",
      "settings.advanced.api_key",
      "settings.advanced.from_address",
    ]) {
      expect(page).toContain(await settingsCopy(label));
    }
  },
);

Then(
  "the owner is told the email settings were updated",
  async function (this: TicketsWorld): Promise<void> {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      await settingsCopy("success.email_settings_updated"),
    );
  },
);

Then(
  "the owner is told the email provider was disabled",
  async function (this: TicketsWorld): Promise<void> {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      await settingsCopy("success.email_provider_disabled"),
    );
  },
);

Then(
  "the site is set to send through {string} from {string}",
  async (provider: string, from: string): Promise<void> => {
    const sending = await howTheSiteSends();
    expect(sending.provider).toBe(provider);
    expect(sending.from).toBe(from);
  },
);

Then("the site is not set to send anything", async (): Promise<void> => {
  // All three, not just the provider: a key left behind is a credential the
  // site holds for an account it no longer uses.
  expect(await howTheSiteSends()).toEqual({
    apiKey: "",
    from: "",
    provider: "",
  });
});

Then("the key the owner typed is the one on file", async (): Promise<void> => {
  // The credential itself, not just the provider beside it. A site that kept
  // the name of a provider without its key cannot send anything at all.
  expect((await howTheSiteSends()).apiKey).toBe(KEY_TYPED_NOW);
});

Then(
  "the key the owner gave earlier is still the one on file",
  async (): Promise<void> => {
    expect((await howTheSiteSends()).apiKey).toBe(KEY_ALREADY_GIVEN);
  },
);

Then(
  "the activity log says the email settings were updated",
  async function (this: TicketsWorld): Promise<void> {
    expect(await activityMessages()).toContain(
      await settingsCopy("success.email_settings_updated"),
    );
  },
);

Then(
  "the from-address box still shows {string}",
  async function (this: TicketsWorld, from: string): Promise<void> {
    expect(await fromAddressTheBoxShows(this)).toBe(from);
  },
);

Then(
  "the page says the site sends through {string}",
  async function (this: TicketsWorld, provider: string): Promise<void> {
    // The box the page really puts back, not merely a choice it offers. Every
    // provider is rendered whether or not it is the one on file, so a page
    // that forgot the stored one would still hold its name somewhere.
    expect(await providerTheBoxShows(this)).toBe(provider);
  },
);

Then(
  "there is a way to send a test email",
  async function (this: TicketsWorld): Promise<void> {
    expect(await offersATestSend(this)).toBe(true);
  },
);

Then(
  "there is no way to send a test email",
  async function (this: TicketsWorld): Promise<void> {
    expect(await offersATestSend(this)).toBe(false);
  },
);

Then(
  "the owner is told no business email is set",
  async function (this: TicketsWorld): Promise<void> {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      await settingsCopy("error.no_business_email"),
    );
  },
);

Then(
  "the owner is told the test email was sent",
  async function (this: TicketsWorld): Promise<void> {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      await settingsCopy("success.test_email_sent", { status: 200 }),
    );
  },
);

Then(
  "the owner is told the test failed with {int} because {string}",
  async function (
    this: TicketsWorld,
    status: number,
    reason: string,
  ): Promise<void> {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      await settingsCopy("error.test_email_failed_reason", { reason, status }),
    );
  },
);

Then(
  "the owner is told the test failed with {int}, and no reason",
  async function (this: TicketsWorld, status: number): Promise<void> {
    const told = whatTheyWereTold(this, ORGANISER);
    expect(told).toContain(
      await settingsCopy("error.test_email_failed", { status }),
    );
    // The bare wording only means something beside its absence: the sentence
    // that carries a reason contains this one as a prefix.
    expect(told).not.toContain("provider said");
  },
);

Then(
  "the owner is told the test failed with no response",
  async function (this: TicketsWorld): Promise<void> {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      await settingsCopy("error.test_email_no_response"),
    );
  },
);
