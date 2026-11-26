import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import type { App, Page } from "#test/blackbox/driver.ts";
import {
  boxTicked,
  followed,
  inputsNamed,
  isTicked,
  loggedIn,
  redirectOf,
  type SettingsForm,
  send,
  testFormGuards,
} from "#test/blackbox/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** One saved choice on a settings page, with its own form. */
interface Choice extends SettingsForm {
  /** The control the page shows the choice with. */
  control: "checkbox" | "radios";
  formId: string;
  /** The choice that a new site starts with, and the one it can change to. */
  other: string;
  questionKey: string;
  /** The name that the page uses for the choice in the message after a save. */
  savedName: string;
  start: string;
}

/* jscpd:ignore-start -- static data, not code */
const LISTING_MODE: Choice = {
  action: "/admin/settings/listing-mode",
  control: "radios",
  field: "listingMode",
  formId: "settings-listing-mode",
  other: "image",
  page: "/admin/settings-advanced",
  questionKey: "settings.advanced.listing_mode",
  savedName: "Listing mode",
  start: "text",
};

const THEME: Choice = {
  action: "/admin/settings/theme",
  control: "radios",
  field: "theme",
  formId: "settings-theme",
  other: "dark",
  page: "/admin/settings",
  questionKey: "settings.theme",
  savedName: "Theme",
  start: "light",
};

const DASHBOARD_TYPE: Choice = {
  action: "/admin/settings/dashboard-type",
  control: "radios",
  field: "dashboardType",
  formId: "settings-dashboard-type",
  other: "groups",
  page: "/admin/settings",
  questionKey: "settings.dashboard_type",
  savedName: "Dashboard type",
  start: "listings",
};

const CHOICES: Choice[] = [
  {
    action: "/admin/settings/external-order",
    control: "checkbox",
    field: "externalOrderEnabled",
    formId: "settings-external-order",
    other: "true",
    page: "/admin/settings-advanced",
    questionKey: "settings.advanced.external_order",
    savedName: "External order buttons",
    start: "false",
  },
  {
    action: "/admin/settings/show-public-api",
    control: "checkbox",
    field: "showPublicApi",
    formId: "settings-show-public-api",
    other: "true",
    page: "/admin/settings-advanced",
    questionKey: "settings.advanced.public_api",
    savedName: "Public API",
    start: "false",
  },
  DASHBOARD_TYPE,
  LISTING_MODE,
  THEME,
];
/* jscpd:ignore-end */

/** The message that the page shows after a save of `value` for `choice`. A
 * checkbox form says whether the setting is enabled. A radio form says which
 * value it saved. */
const savedMessage = (choice: Choice, value: string): string =>
  choice.control === "checkbox"
    ? `${choice.savedName} ${value === "true" ? "enabled" : "disabled"}`
    : `${choice.savedName} set to ${value}`;

/** The value the page shows as chosen for one control. A checkbox sends
 * "true" only while it is ticked, so an unticked box reads as "false". */
const chosenValue = (html: string, choice: Choice): string => {
  if (choice.control === "checkbox")
    return boxTicked(html, choice.field) ? "true" : "false";
  const chosen = inputsNamed(html, choice.field).find(isTicked);
  const value = chosen?.match(/\svalue="([^"]*)"/)?.[1];
  if (value === undefined) {
    throw new Error(`The page shows no chosen radio for "${choice.field}".`);
  }
  return value;
};

const pick = (app: App, choice: Choice, value: string): Promise<Page> =>
  send(app, choice, { [choice.field]: value });

const chosenNow = async (app: App, choice: Choice): Promise<string> =>
  chosenValue((await app.get(choice.page)).html, choice);

for (const choice of CHOICES) {
  describeWithEnv(`the setting ${choice.action}`, { db: true }, () => {
    test("the page asks the question, with the starting choice chosen", async () => {
      const app = await loggedIn();
      const page = await app.get(choice.page);
      expect(page.status).toBe(200);
      expect(page.html).toContain(t(choice.questionKey));
      expect(chosenValue(page.html, choice)).toBe(choice.start);
    });

    test("a new choice saves, says so beside its form, and stays chosen", async () => {
      const app = await loggedIn();
      const sent = await pick(app, choice, choice.other);
      const to = new URL(redirectOf(sent), "http://localhost");
      expect(to.pathname).toBe(choice.page);
      expect(to.searchParams.get("form")).toBe(choice.formId);
      expect((await followed(app, sent)).html).toContain(
        savedMessage(choice, choice.other),
      );
      expect(await chosenNow(app, choice)).toBe(choice.other);
    });

    test("the starting choice saves again after a change", async () => {
      const app = await loggedIn();
      await pick(app, choice, choice.other);
      const back = await followed(app, await pick(app, choice, choice.start));
      expect(back.html).toContain(savedMessage(choice, choice.start));
      expect(await chosenNow(app, choice)).toBe(choice.start);
    });

    testFormGuards(
      choice,
      choice.other,
      (app) => chosenNow(app, choice),
      choice.start,
    );
  });
}

const REFUSALS: [choice: Choice, messageKey: string][] = [
  [DASHBOARD_TYPE, "error.invalid_dashboard_type"],
  [LISTING_MODE, "error.invalid_listing_mode"],
  [THEME, "error.invalid_theme"],
];

for (const [choice, messageKey] of REFUSALS) {
  describeWithEnv(`the setting ${choice.action}`, { db: true }, () => {
    describe("refuses a value it does not offer", () => {
      for (const value of ["nonsense", null]) {
        test(`refuses ${value ?? "no value"} and keeps the saved choice`, async () => {
          const app = await loggedIn();
          const sent = await send(app, choice, { [choice.field]: value });
          expect((await followed(app, sent)).html).toContain(t(messageKey));
          expect(await chosenNow(app, choice)).toBe(choice.start);
        });
      }
    });
  });
}

describeWithEnv("the underline links box", { db: true }, () => {
  const underlined = async (app: App): Promise<boolean> =>
    boxTicked((await app.get(THEME.page)).html, "underlineLinks");

  test("a ticked box saves, and an unticked box saves again", async () => {
    const app = await loggedIn();
    expect(await underlined(app)).toBe(false);

    redirectOf(await send(app, THEME, { underlineLinks: "true" }));
    expect(await underlined(app)).toBe(true);

    redirectOf(await send(app, THEME, { underlineLinks: null }));
    expect(await underlined(app)).toBe(false);
  });
});
