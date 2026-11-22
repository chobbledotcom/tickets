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

/** One radio choice on a settings page, with its own form. */
interface Choice extends SettingsForm {
  formId: string;
  /** The choice that a new site starts with, and the one it can change to. */
  other: string;
  questionKey: string;
  /** The message after a save of `value`. */
  saved: (value: string) => string;
  start: string;
}

const yesNo = (label: string) => (value: string) =>
  `${label} ${value === "true" ? "enabled" : "disabled"}`;

const LISTING_MODE: Choice = {
  action: "/admin/settings/listing-mode",
  field: "listingMode",
  formId: "settings-listing-mode",
  other: "image",
  page: "/admin/settings-advanced",
  questionKey: "settings.advanced.listing_mode",
  saved: (value) => `Listing mode set to ${value}`,
  start: "text",
};

const THEME: Choice = {
  action: "/admin/settings/theme",
  field: "theme",
  formId: "settings-theme",
  other: "dark",
  page: "/admin/settings",
  questionKey: "settings.theme",
  saved: (value) => `Theme set to ${value}`,
  start: "light",
};

const CHOICES: Choice[] = [
  {
    action: "/admin/settings/external-order",
    field: "externalOrderEnabled",
    formId: "settings-external-order",
    other: "true",
    page: "/admin/settings-advanced",
    questionKey: "settings.advanced.external_order",
    saved: yesNo("External order buttons"),
    start: "false",
  },
  {
    action: "/admin/settings/show-public-api",
    field: "showPublicApi",
    formId: "settings-show-public-api",
    other: "true",
    page: "/admin/settings-advanced",
    questionKey: "settings.advanced.public_api",
    saved: yesNo("Public API"),
    start: "false",
  },
  LISTING_MODE,
  THEME,
];

/** The value of the radio that the page shows as chosen. */
const chosenValue = (html: string, field: string): string => {
  const chosen = inputsNamed(html, field).find(isTicked);
  const value = chosen?.match(/\svalue="([^"]*)"/)?.[1];
  if (value === undefined) {
    throw new Error(`The page shows no chosen radio for "${field}".`);
  }
  return value;
};

const pick = (app: App, choice: Choice, value: string): Promise<Page> =>
  send(app, choice, { [choice.field]: value });

const chosenNow = async (app: App, choice: Choice): Promise<string> =>
  chosenValue((await app.get(choice.page)).html, choice.field);

for (const choice of CHOICES) {
  describeWithEnv(`the setting ${choice.action}`, { db: true }, () => {
    test("the page asks the question, with the starting choice chosen", async () => {
      const app = await loggedIn();
      const page = await app.get(choice.page);
      expect(page.status).toBe(200);
      expect(page.html).toContain(t(choice.questionKey));
      expect(chosenValue(page.html, choice.field)).toBe(choice.start);
    });

    test("a new choice saves, says so beside its form, and stays chosen", async () => {
      const app = await loggedIn();
      const sent = await pick(app, choice, choice.other);
      const to = new URL(redirectOf(sent), "http://localhost");
      expect(to.pathname).toBe(choice.page);
      expect(to.searchParams.get("form")).toBe(choice.formId);
      expect((await followed(app, sent)).html).toContain(
        choice.saved(choice.other),
      );
      expect(await chosenNow(app, choice)).toBe(choice.other);
    });

    test("the starting choice saves again after a change", async () => {
      const app = await loggedIn();
      await pick(app, choice, choice.other);
      const back = await followed(app, await pick(app, choice, choice.start));
      expect(back.html).toContain(choice.saved(choice.start));
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
