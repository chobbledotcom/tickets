/**
 * Branch cover for the email-template routes, beside the story
 * `@story:settings.writing-the-emails-the-site-sends`.
 *
 * The story owns the owner's journey: both templates offered by name with the
 * site's own wording showing through, writing custom wording and having it
 * kept, clearing it again, and being refused wording the site cannot read.
 *
 * These own what a story must not be the only cover of: that the wording is
 * encrypted at rest, the length ceiling, a send carrying no fields at all, and
 * the refusal branch, which the story reads the words of but cannot cover,
 * because a Cucumber run does not count towards coverage.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { MAX_EMAIL_TEMPLATE_LENGTH } from "#db/settings/constants.ts";
import { ALL_SETTINGS_KEYS, CONFIG_KEYS, settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { resetEngine } from "#shared/email-renderer.ts";
import {
  expectFlash,
  expectRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

// jscpd:ignore-end

const CONFIRMATION_PATH = "/admin/settings/email-templates/confirmation";
const ADMIN_PATH = "/admin/settings/email-templates/admin";

const NOTHING_KEPT = { html: "", subject: "", text: "" };

/** Wording no Liquid engine can read, whichever box it is typed into. */
const UNREADABLE = "{% for x in items %}unclosed";

/** Where each email's save lands, and what it says when it gets there. Both
 * emails share one handler, so a swapped label tells the owner they saved the
 * other email, and the wrong page leaves them nowhere near their boxes. */
const SAVING_EACH_EMAIL = [
  {
    formId: "settings-email-tpl-confirmation",
    path: CONFIRMATION_PATH,
    said: "Confirmation email template updated",
  },
  {
    formId: "settings-email-tpl-admin",
    path: ADMIN_PATH,
    said: "Admin notification email template updated",
  },
] as const;

describeWithEnv("admin email templates", { db: true }, () => {
  beforeEach(resetEngine);
  afterEach(resetEngine);

  const postTemplateFormTo = async (
    path: string,
    fields: Record<string, string>,
  ) =>
    await handleRequest(
      mockFormRequest(
        path,
        { ...fields, csrf_token: await testCsrfToken() },
        await testCookie(),
      ),
    );

  const postTemplateForm = (fields: Record<string, string>) =>
    postTemplateFormTo(CONFIRMATION_PATH, fields);

  const storedTemplate = async (): Promise<{
    html: string;
    subject: string;
    text: string;
  }> => {
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);
    const kept = settings.email.templateSet("confirmation");
    return { html: kept.html, subject: kept.subject, text: kept.text };
  };

  testRequiresAuth(CONFIRMATION_PATH, {
    body: { subject: "test" },
    method: "POST",
  });

  test("stores the owner's wording encrypted at rest", async () => {
    // The wording carries a business's own voice and often its addresses, so
    // it is encrypted like every other stored setting. A story cannot see
    // this: it reads what the site would send, which is the decrypted value.
    await postTemplateForm({
      html: "<b>{{ attendee.name }}</b>",
      subject: "Custom: {{ listing_names }}",
      text: "Hi {{ attendee.name }}",
    });
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    for (const key of [
      CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_SUBJECT,
      CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_HTML,
      CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_TEXT,
    ]) {
      const raw = settings.getCachedRaw(key);
      expect(raw).not.toBeNull();
      expect(raw?.startsWith("enc:1:")).toBe(true);
    }
    // Not merely prefixed: the plaintext must not be sitting there beside it.
    expect(
      settings.getCachedRaw(CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_SUBJECT),
    ).not.toContain("listing_names");

    // And it reads back as what the owner wrote.
    expect(await storedTemplate()).toEqual({
      html: "<b>{{ attendee.name }}</b>",
      subject: "Custom: {{ listing_names }}",
      text: "Hi {{ attendee.name }}",
    });
  });

  test("refuses wording past the ceiling, and keeps nothing", async () => {
    // The boundary read from the constant the route enforces, so a changed
    // ceiling moves this test with it rather than leaving it asserting a
    // number nothing uses any more.
    const response = await postTemplateForm({
      html: "x".repeat(MAX_EMAIL_TEMPLATE_LENGTH + 1),
      subject: "",
      text: "",
    });

    expect(response.status).toBe(302);
    expectFlash(
      response,
      expect.stringContaining("Template html exceeds maximum length"),
      false,
    );
    expect(await storedTemplate()).toEqual(NOTHING_KEPT);
  });

  test("accepts wording exactly at the ceiling", async () => {
    // The other side of the same boundary, so an off-by-one in the guard
    // fails here rather than silently refusing wording that should fit.
    const atTheLimit = "x".repeat(MAX_EMAIL_TEMPLATE_LENGTH);
    const response = await postTemplateForm({
      html: atTheLimit,
      subject: "",
      text: "",
    });

    expect(response.status).toBe(302);
    expect((await storedTemplate()).html).toBe(atTheLimit);
  });

  for (const box of ["subject", "html", "text"] as const) {
    test(`names the ${box} box when it holds wording the site cannot read`, async () => {
      // The story reads the refusal, but a Cucumber run does not count towards
      // coverage, so this arm needs direct tests. One per box, because a
      // refusal that does not say which box is one the owner cannot act on.
      const response = await postTemplateForm({
        ...NOTHING_KEPT,
        [box]: UNREADABLE,
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(`Invalid template syntax in ${box}`),
        false,
      );
      expect(await storedTemplate()).toEqual(NOTHING_KEPT);
    });
  }

  for (const { formId, path, said } of SAVING_EACH_EMAIL) {
    test(`says "${said}" and lands beside those boxes`, async () => {
      // Where a save lands is a URL contract a story cannot see, because the
      // browser follows the redirect before the scenario reads the page.
      expectRedirectWithFlash(
        `/admin/settings-advanced?form=${formId}#${formId}`,
        said,
      )(await postTemplateFormTo(path, NOTHING_KEPT));
    });
  }

  test("treats a send carrying no fields at all as clearing the wording", async () => {
    // The form always carries all three boxes, so this send is one no browser
    // could have made. The story owns clearing them on the page.
    const response = await postTemplateForm({});

    expect(response.status).toBe(302);
    expect(await storedTemplate()).toEqual(NOTHING_KEPT);
  });
});
