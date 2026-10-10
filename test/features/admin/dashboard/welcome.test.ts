import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { WELCOME_STEPS } from "#templates/admin/welcome-banner.tsx";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import {
  adminGet,
  createTestEditorSession,
  createTestManagerSession,
  loginAsAdmin,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";
import { enablePublicSite, settingsAsStored } from "#test-utils/settings.ts";

const BANNER_MARK = 'class="welcome-banner"';

/** POST the dismiss form from one session's cookie. */
const postDismiss = (cookie: string, csrfToken: string): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      "/admin/welcome/dismiss",
      { csrf_token: csrfToken },
      cookie,
    ),
  );

/** The welcome flag as the site stores it, or null while nothing stored it. */
const storedWelcome = async (): Promise<string | null> => {
  await settingsAsStored();
  const row = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [CONFIG_KEYS.WELCOME_ENABLED],
  );
  return row?.value ?? null;
};

/** Remove the stored welcome flag, so the store reads as one from before the
 *  flag existed. */
const forgetWelcomeKey = async (): Promise<void> => {
  await execute("DELETE FROM settings WHERE key = ?", [
    CONFIG_KEYS.WELCOME_ENABLED,
  ]);
};

/** The banner's own HTML, cut out of the page. */
const bannerHtml = (html: string): string =>
  html.slice(
    html.indexOf('<section class="welcome-banner"'),
    html.indexOf("</section>") + "</section>".length,
  );

describeWithEnv("admin dashboard welcome", { db: true }, () => {
  test("hides the banner while the settings store holds no welcome key", async () => {
    await forgetWelcomeKey();
    expect(await storedWelcome()).toBeNull();
    const html = await (await adminGet("/admin/")).text();
    expect(html).not.toContain(BANNER_MARK);
    expect(html).toContain("Add Listing");
  });

  test("keeps the welcome message hidden once the site stores it as off", async () => {
    await settings.setRaw(CONFIG_KEYS.WELCOME_ENABLED, "false");
    const html = await (await adminGet("/admin/")).text();
    expect(html).not.toContain(BANNER_MARK);
    expect(html).toContain("Add Listing");
  });

  test("shows the owner the welcome steps and the Got it button", async () => {
    // The test store is one the setup ceremony just ran, so the message is on.
    const banner = bannerHtml(await (await adminGet("/admin/")).text());
    expect(banner).toContain("Welcome to your new Chobble Tickets site");
    expect(banner).toContain(
      "Here are the first things to do on your new site.",
    );
    // The public booking link renders only while the site feature is on; the
    // route test below covers it in that state.
    for (const { href, needsSite } of WELCOME_STEPS) {
      if (needsSite) continue;
      expect(banner, href).toContain(`href="${href}"`);
    }
    expect(banner).toContain("Got it");
    expect(banner).toContain('action="/admin/welcome/dismiss"');
  });

  test("keeps the whole banner inside the dismiss form and the steps in one prose block", async () => {
    const banner = bannerHtml(await (await adminGet("/admin/")).text());
    const formStart = banner.indexOf('action="/admin/welcome/dismiss"');
    const proseStart = banner.indexOf('<div class="prose">');
    const headingStart = banner.indexOf("<h2>");
    const introStart = banner.indexOf("Here are the first things to do");
    const stepStart = banner.indexOf("Add a listing");
    const proseEnd = banner.indexOf("</div>", proseStart);
    expect(formStart).toBeGreaterThanOrEqual(0);
    expect(proseStart).toBeGreaterThan(formStart);
    expect(headingStart).toBeGreaterThan(proseStart);
    expect(introStart).toBeGreaterThan(headingStart);
    expect(stepStart).toBeGreaterThan(introStart);
    expect(proseEnd).toBeGreaterThan(stepStart);
    expect(banner.indexOf("Got it")).toBeGreaterThan(proseEnd);
  });

  test("shows a manager the dashboard without the welcome message", async () => {
    const cookie = await createTestManagerSession();
    const html = await (await awaitTestRequest("/admin/", { cookie })).text();
    expect(html).toContain("Add Listing");
    expect(html).not.toContain(BANNER_MARK);
    expect(html).not.toContain("Got it");
  });

  test("sends an editor to the listings page without the welcome message", async () => {
    const { cookie } = await createTestEditorSession();
    const landing = await awaitTestRequest("/admin/", { cookie });
    expect(landing.status).toBe(302);
    expect(landing.headers.get("location")).toBe("/admin/listings");
    const html = await (
      await awaitTestRequest("/admin/listings", { cookie })
    ).text();
    expect(html).not.toContain(BANNER_MARK);
    expect(html).not.toContain("Got it");
  });

  test("stores the dismissal for later logins", async () => {
    expect(await (await adminGet("/admin/")).text()).toContain(BANNER_MARK);

    const response = await postDismiss(
      await testCookie(),
      await testCsrfToken(),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/^\/admin(\?|$)/);
    expect(await storedWelcome()).toBe("false");

    // A later login is a fresh session over the same stored site state.
    const { cookie } = await loginAsAdmin();
    const htmlAfter = await (
      await awaitTestRequest("/admin/", { cookie })
    ).text();
    expect(htmlAfter).not.toContain(BANNER_MARK);
  });

  test("refuses the dismissal without a valid CSRF token", async () => {
    const storedBefore = await storedWelcome();
    const response = await postDismiss(await testCookie(), "not-a-token");
    expect(response.status).toBe(403);
    expect(await storedWelcome()).toBe(storedBefore);
  });

  test("refuses the dismissal to a role the route does not declare", async () => {
    const storedBefore = await storedWelcome();
    const cookie = await createTestManagerSession();
    const response = await postDismiss(cookie, await signCsrfToken());
    expect(response.status).toBe(403);
    expect(await storedWelcome()).toBe(storedBefore);
  });

  test("shows the test booking step as plain text while the site is unpublished", async () => {
    const html = await (await adminGet("/admin/")).text();
    expect(html).toContain(
      "Make a test booking and check the money and emails arrive",
    );
    expect(html).not.toContain('href="/listings"');
  });

  test("hides the welcome banner in read-only mode", async () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = await (await adminGet("/admin/")).text();
    expect(html).not.toContain(BANNER_MARK);
    expect(html).not.toContain("Got it");
  });

  test("points every welcome step at a page the site serves", async () => {
    await enablePublicSite();
    for (const { href } of WELCOME_STEPS) {
      const response = await adminGet(href);
      expect(response.status, href).toBe(200);
    }
  });
});
