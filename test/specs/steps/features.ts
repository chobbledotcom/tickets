// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { ORGANISER, openAsNewcomer } from "#test/specs/support/browser.ts";
import {
  everyFeatureName,
  featureNamed,
  featurePageHtml,
  keepSiteForReadingOnly,
  linkToFeature,
  ownerChoosesFeature,
  ownerLooksAtSettings,
  ownerOpensFeature,
  saveAModifiersItem,
  statusShownFor,
} from "#test/specs/support/features.ts";
import {
  answerTicked,
  choicesForQuestion,
} from "#test/specs/support/form-controls/reading.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { activityMessages } from "#test-utils/activity-log.ts";

// jscpd:ignore-end

/** The field the two radios send under. It never reaches a story — the owner
 * reads Yes and No, so that is what the story says. */
const CHOICE_FIELD = "enabled";

const ownerEnables = ownerChoosesFeature(true);
const ownerDisables = ownerChoosesFeature(false);

Given(
  "the site already holds a saved Modifiers item",
  async (): Promise<void> => {
    await saveAModifiersItem();
  },
);

Given("the site is kept for reading only", function (this: TicketsWorld): void {
  keepSiteForReadingOnly(this);
});

// Cucumber matches on the text alone, so this is registered once and the
// story reaches it under Given or When as its own sentence needs.
When(
  "the owner enables {string}",
  function (this: TicketsWorld, printed: string): Promise<void> {
    return ownerEnables(this, printed);
  },
);

When(
  "the owner disables {string}",
  function (this: TicketsWorld, printed: string): Promise<void> {
    return ownerDisables(this, printed);
  },
);

When(
  "the owner looks at their settings",
  function (this: TicketsWorld): Promise<void> {
    return ownerLooksAtSettings(this);
  },
);

When(
  "the owner opens the {string} feature",
  function (this: TicketsWorld, printed: string): Promise<void> {
    return ownerOpensFeature(this, printed);
  },
);

Then(
  "every feature is listed as Disabled",
  async function (this: TicketsWorld): Promise<void> {
    const list = whatTheyWereTold(this, ORGANISER);
    // Every feature's own row, not one word found anywhere: a list that named
    // eight and said Enabled against one would pass a single search.
    for (const name of await everyFeatureName()) {
      expect(await statusShownFor(list, name)).toBe(
        t("features.status.disabled"),
      );
    }
  },
);

Then(
  "every feature links to the page that explains it",
  async function (this: TicketsWorld): Promise<void> {
    const list = whatTheyWereTold(this, ORGANISER);
    for (const name of await everyFeatureName()) {
      expect(list).toContain(linkToFeature(await featureNamed(name)));
    }
  },
);

Then(
  "{string} is listed as Enabled",
  async function (this: TicketsWorld, printed: string): Promise<void> {
    const list = whatTheyWereTold(this, ORGANISER);
    expect(await statusShownFor(list, printed)).toBe(
      t("features.status.enabled"),
    );
  },
);

Then(
  "they are told what {string} does",
  async function (this: TicketsWorld, printed: string): Promise<void> {
    const page = whatTheyWereTold(this, ORGANISER);
    expect(page).toContain(t((await featureNamed(printed)).descriptionKey));
  },
);

Then("they are offered the choice", function (this: TicketsWorld): void {
  expect(
    choicesForQuestion(whatTheyWereTold(this, ORGANISER), CHOICE_FIELD),
  ).toEqual(["true", "false"]);
});

Then("they are offered no choice", function (this: TicketsWorld): void {
  expect(
    choicesForQuestion(whatTheyWereTold(this, ORGANISER), CHOICE_FIELD),
  ).toEqual([]);
});

Then(
  "the owner is told {string}",
  function (this: TicketsWorld, message: string): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(message);
  },
);

Then(
  "the activity log says {string}",
  async function (this: TicketsWorld, message: string): Promise<void> {
    expect(await activityMessages()).toContain(message);
  },
);

/** What the feature's own page offers when it is opened again. Reading the
 * radio the page ticked proves the choice was kept and rendered back, which a
 * stored value alone would not. */
const comesBackOffering = (answer: string) =>
  async function (this: TicketsWorld, printed: string): Promise<void> {
    const page = await featurePageHtml(this, printed);
    expect(answerTicked(page, CHOICE_FIELD)).toBe(answer);
  };

Then("the {string} page comes back offering Yes", comesBackOffering("true"));

Then("the {string} page comes back offering No", comesBackOffering("false"));

/** What the feature's own page says about it, always read beside the feature's
 * own name, so a page about some other feature could never answer for it. */
const pageAboutFeatureSays = (...keys: string[]) =>
  async function (this: TicketsWorld, printed: string): Promise<void> {
    const page = whatTheyWereTold(this, ORGANISER);
    expect(page).toContain(t((await featureNamed(printed)).labelKey));
    for (const key of keys) expect(page).toContain(t(key));
  };

Then(
  "they are told {string} is in use",
  pageAboutFeatureSays("features.in_use"),
);

Then(
  "they are told {string} is Disabled",
  pageAboutFeatureSays("features.status_label", "features.status.disabled"),
);

Then(
  "they are told to remove its saved items first",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("features.in_use_help"),
    );
  },
);

Then(
  "a visitor opening the front page is sent to sign in",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAsNewcomer("/");
    expect(browser.currentUrl).toBe("/admin/login");
  },
);

Then(
  "a visitor can read the front page",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAsNewcomer("/");
    expect(browser.currentUrl).toBe("/");
  },
);
