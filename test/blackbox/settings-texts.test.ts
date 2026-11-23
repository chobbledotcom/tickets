import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import type { App } from "#test/blackbox/driver.ts";
import {
  followed,
  loggedIn,
  redirectOf,
  type SettingsForm,
  send,
  sendLoggedOut,
  sendWithWrongToken,
} from "#test/blackbox/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { decodeEntities } from "#test-utils/test-browser/parsing.ts";

/** One text setting with its own form. */
interface TextSetting extends SettingsForm {
  /** The message after a save of an empty box. */
  cleared: string;
  /** The words that the page shows for the setting. */
  label: string;
  /** The message after a save of `value`. */
  saved: string;
  value: string;
}

const BUSINESS_EMAIL: TextSetting = {
  action: "/admin/settings/business-email",
  cleared: "Business email cleared",
  field: "businessEmail",
  label: t("settings.business_email"),
  page: "/admin/settings",
  saved: "Business email updated",
  value: "contact@example.com",
};

const CUSTOM_CSS: TextSetting = {
  action: "/admin/settings/custom-css",
  cleared: "Custom CSS removed",
  field: "customCss",
  label: t("settings.advanced.custom_css"),
  page: "/admin/settings-advanced",
  saved: "Custom CSS updated",
  value: "body { color: red; }",
};

const SITE_FOOTER: TextSetting = {
  action: "/admin/settings/site-footer",
  cleared: t("success.site_footer_removed"),
  field: "siteFooter",
  label: t("settings.site_footer"),
  page: "/admin/settings",
  saved: t("success.site_footer_updated"),
  value: "Thank you for supporting our event!",
};

const TERMS: TextSetting = {
  action: "/admin/settings/terms",
  cleared: t("success.terms_removed"),
  field: "termsAndConditions",
  label: t("settings.terms"),
  page: "/admin/settings",
  saved: t("success.terms_updated"),
  value: "By registering you agree to our listing policy.",
};

/** The text that the page holds in the box named `field`. */
const boxText = (html: string, field: string): string => {
  const area = html.match(
    new RegExp(`<textarea\\b[^>]*name="${field}"[^>]*>([\\s\\S]*?)</textarea>`),
  );
  if (area !== null) return decodeEntities((area[1] ?? "").replace(/^\n/, ""));
  const input = html.match(new RegExp(`<input\\b[^>]*name="${field}"[^>]*>`));
  if (input === null) throw new Error(`The page shows no box "${field}".`);
  return decodeEntities(input[0].match(/\svalue="([^"]*)"/)?.[1] ?? "");
};

/** The most characters that the page lets the box named `field` hold. */
const boxLimit = (html: string, field: string): number => {
  const tag = html.match(new RegExp(`<textarea\\b[^>]*name="${field}"[^>]*>`));
  const limit = tag?.[0].match(/\smaxlength="(\d+)"/)?.[1];
  if (limit === undefined) throw new Error(`The box "${field}" has no limit.`);
  return Number(limit);
};

const textNow = async (app: App, setting: TextSetting): Promise<string> =>
  boxText((await app.get(setting.page)).html, setting.field);

/** The owner saves `value` and reads the message on the next page. */
const save = async (
  app: App,
  setting: TextSetting,
  value: string | null,
): Promise<string> =>
  (await followed(app, await send(app, setting, { [setting.field]: value })))
    .html;

const activityLog = async (app: App): Promise<string> =>
  (await app.get("/admin/log")).html;

for (const setting of [BUSINESS_EMAIL, CUSTOM_CSS, SITE_FOOTER, TERMS]) {
  describeWithEnv(`the setting ${setting.action}`, { db: true }, () => {
    test("the page shows the setting with an empty box", async () => {
      const app = await loggedIn();
      const page = await app.get(setting.page);
      expect(page.status).toBe(200);
      expect(page.html).toContain(setting.label);
      expect(boxText(page.html, setting.field)).toBe("");
    });

    test("a save says so, stays in the box, and shows in the activity log", async () => {
      const app = await loggedIn();
      expect(await save(app, setting, setting.value)).toContain(setting.saved);
      expect(await textNow(app, setting)).toBe(setting.value);
      expect(await activityLog(app)).toContain(setting.saved);
    });

    test("an empty box clears the saved text, and shows in the activity log", async () => {
      const app = await loggedIn();
      await save(app, setting, setting.value);
      expect(await save(app, setting, "")).toContain(setting.cleared);
      expect(await textNow(app, setting)).toBe("");
      expect(await activityLog(app)).toContain(setting.cleared);
    });

    test("a form with a wrong token is refused and changes nothing", async () => {
      const app = await loggedIn();
      const refused = await sendWithWrongToken(app, setting, setting.value);
      expect(refused.status).toBe(403);
      expect(refused.html).toContain("Invalid CSRF token");
      expect(await textNow(app, setting)).toBe("");
    });

    test("a visitor who is not logged in is sent to the login and changes nothing", async () => {
      const response = await sendLoggedOut(setting, setting.value);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
      expect(await textNow(await loggedIn(), setting)).toBe("");
    });
  });
}

for (const setting of [CUSTOM_CSS, SITE_FOOTER, TERMS]) {
  describeWithEnv(`the limit of ${setting.action}`, { db: true }, () => {
    test("text past the limit of the box is refused and keeps the saved text", async () => {
      const app = await loggedIn();
      await save(app, setting, setting.value);
      const limit = boxLimit((await app.get(setting.page)).html, setting.field);
      const after = await save(app, setting, "x".repeat(limit + 1));
      expect(after).toContain(`${limit} characters or fewer`);
      expect(await textNow(app, setting)).toBe(setting.value);
    });

    test("text at the limit of the box saves", async () => {
      const app = await loggedIn();
      const limit = boxLimit((await app.get(setting.page)).html, setting.field);
      const full = "x".repeat(limit);
      expect(await save(app, setting, full)).toContain(setting.saved);
      expect(await textNow(app, setting)).toBe(full);
    });
  });
}

describeWithEnv(
  "the setting texts that need their own rules",
  { db: true },
  () => {
    test("a business email that is not an email address is refused", async () => {
      const app = await loggedIn();
      const after = await save(app, BUSINESS_EMAIL, "not-an-email");
      expect(after).toContain(t("error.email_format"));
      expect(await textNow(app, BUSINESS_EMAIL)).toBe("");
    });

    test("terms sent with no box at all are cleared", async () => {
      const app = await loggedIn();
      await save(app, TERMS, TERMS.value);
      expect(await save(app, TERMS, null)).toContain(TERMS.cleared);
      expect(await textNow(app, TERMS)).toBe("");
    });

    test("the site footer and terms show their formatting help", async () => {
      const app = await loggedIn();
      const page = await app.get("/admin/settings");
      const help = t("common.formatting_help");
      expect(page.html.split(help).length - 1).toBeGreaterThanOrEqual(2);
    });

    describe("the policy for Bunny's fonts follows the saved CSS", () => {
      const fontsAllowed = async (app: App): Promise<boolean> => {
        const policy = (await app.get("/")).headers.get(
          "content-security-policy",
        );
        if (policy === null) throw new Error("The page sends no policy.");
        return policy.includes("https://fonts.bunny.net");
      };

      test("CSS that loads Bunny's fonts allows them, and other CSS does not", async () => {
        const app = await loggedIn();
        expect(await fontsAllowed(app)).toBe(false);

        redirectOf(
          await send(app, CUSTOM_CSS, {
            customCss: "@import url(https://fonts.bunny.net/css?family=aleo);",
          }),
        );
        expect(await fontsAllowed(app)).toBe(true);

        await save(app, CUSTOM_CSS, CUSTOM_CSS.value);
        expect(await fontsAllowed(app)).toBe(false);

        redirectOf(
          await send(app, CUSTOM_CSS, {
            customCss: "@import url(https://fonts.bunny.net/css?family=aleo);",
          }),
        );
        await save(app, CUSTOM_CSS, "");
        expect(await fontsAllowed(app)).toBe(false);
      });
    });
  },
);
