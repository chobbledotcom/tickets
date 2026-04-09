import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { CSS_PATH, JS_PATH } from "#lib/asset-paths.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import { adminLoginPage } from "#templates/admin/login.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";
import { buildTicketEvent, ticketPage } from "#templates/public.tsx";
import {
  describeWithEnv,
  setupTestEncryptionKey,
  testEventWithCount,
} from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("asset-paths", () => {
  test("pages include CSS_PATH in stylesheet link", () => {
    const html = adminLoginPage();
    expect(html).toContain(`href="${CSS_PATH}"`);
    expect(html).toContain('rel="stylesheet"');
  });

  test("pages include JS_PATH in deferred script tag", () => {
    const html = adminLoginPage();
    expect(html).toContain(`src="${JS_PATH}"`);
    expect(html).toContain("defer");
  });
});

describe("Layout skip navigation", () => {
  test("renders skip-nav link targeting main-content", () => {
    const html = String(Layout({ title: "Test", children: "" }));
    expect(html).toContain('class="skip-nav"');
    expect(html).toContain('href="#main-content"');
    expect(html).toContain("Skip to content");
    expect(html).toContain('id="main-content"');
    expect(html).toContain('tabindex="-1"');
  });
});

describe("adminLoginPage", () => {
  test("renders login form", () => {
    const html = adminLoginPage();
    expect(html).toContain("Login");
    expect(html).toContain('action="/admin/login"');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="csrf_token"');
  });

  test("shows error when provided", () => {
    const html = adminLoginPage("Invalid password");
    expect(html).toContain("Invalid password");
    expect(html).toContain('class="error"');
  });

  test("escapes error message", () => {
    const html = adminLoginPage("<script>evil()</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describeWithEnv(
  "read-only mode templates",
  { env: { READ_ONLY: "true" } },
  () => {
    test("AdminNav shows read-only banner", () => {
      const html = String(
        AdminNav({ session: TEST_SESSION, active: "/admin/" }),
      );
      expect(html).toContain("read-only-banner");
      expect(html).toContain("This site is in read-only mode");
    });

    test("ticketPage hides booking form in read-only mode", () => {
      const event = testEventWithCount({ attendee_count: 0 });
      const html = ticketPage({
        events: [buildTicketEvent(event)],
        slugs: [event.slug],
        dates: [],
      });
      expect(html).toContain("Registration closed.");
      expect(html).not.toContain("Continue");
    });
  },
);
