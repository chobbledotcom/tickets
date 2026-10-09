import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryOne } from "#db/client.ts";
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
import {
  enablePublicSite,
  settingsAsStored,
  withSetting,
} from "#test-utils/settings.ts";

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

/** The dismissal flag as the site stores it, or null while nothing stored it. */
const storedDismissal = async (): Promise<string | null> => {
  await settingsAsStored();
  const row = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [CONFIG_KEYS.WELCOME_DISMISSED],
  );
  return row?.value ?? null;
};

describeWithEnv("admin dashboard welcome", { db: true }, () => {
  test("shows the owner the welcome steps and the Got it button", async () => {
    const html = await (await adminGet("/admin/")).text();
    expect(html).toContain(BANNER_MARK);
    expect(html).toContain("Here are the first things to do on your new site.");
    // The public booking link renders only while the site feature is on; the
    // route test below covers it in that state.
    for (const { href, needsSite } of WELCOME_STEPS) {
      if (needsSite) continue;
      expect(html, href).toContain(`href="${href}"`);
    }
    expect(html).toContain("Got it");
    expect(html).toContain('action="/admin/welcome/dismiss"');
  });

  test("keeps the welcome message hidden once the site stores the dismissal", async () => {
    const html = await withSetting({ welcome_dismissed: true }, async () =>
      (await adminGet("/admin/")).text(),
    );
    expect(html).not.toContain(BANNER_MARK);
    expect(html).toContain("Add Listing");
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
    expect(await storedDismissal()).toBe("true");

    // A later login is a fresh session over the same stored site state.
    const { cookie } = await loginAsAdmin();
    const htmlAfter = await (
      await awaitTestRequest("/admin/", { cookie })
    ).text();
    expect(htmlAfter).not.toContain(BANNER_MARK);
  });

  test("refuses the dismissal without a valid CSRF token", async () => {
    const response = await postDismiss(await testCookie(), "not-a-token");
    expect(response.status).toBe(403);
    expect(await storedDismissal()).toBeNull();

    const html = await (await adminGet("/admin/")).text();
    expect(html).toContain(BANNER_MARK);
  });

  test("refuses the dismissal to a role the route does not declare", async () => {
    const cookie = await createTestManagerSession();
    const response = await postDismiss(cookie, await signCsrfToken());
    expect(response.status).toBe(403);
    expect(await storedDismissal()).toBeNull();
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
