import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { CSS_PATH, JS_PATH } from "#shared/asset-paths.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { adminLoginPage } from "#templates/admin/login.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";
import { buildTicketListing, ticketPage } from "#templates/public.tsx";
import {
  describeWithEnv,
  setupTestEncryptionKey,
  testListingWithCount,
} from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

/** Set `RENEWAL_URL`, render `AdminNav`, assert the renewal link is present,
 *  and clean up the env var. Both the read-only and warning-banner describe
 *  blocks repeat this exact sequence. */
const expectRenewalLink = async (): Promise<void> => {
  Deno.env.set("RENEWAL_URL", "https://example.com/renew");
  try {
    const html = String(AdminNav({ active: "/admin/", session: TEST_SESSION }));
    expect(html).toContain("Renew now");
    expect(html).toContain("https://example.com/renew");
  } finally {
    Deno.env.delete("RENEWAL_URL");
  }
};

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
    const html = String(Layout({ children: "", title: "Test" }));
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
  { env: { READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" } },
  () => {
    test("AdminNav shows read-only banner", () => {
      const html = String(
        AdminNav({ active: "/admin/", session: TEST_SESSION }),
      );
      expect(html).toContain("read-only-banner");
      expect(html).toContain("This site is in read-only mode");
    });

    test("AdminNav read-only banner includes renewal link when RENEWAL_URL is set", async () => {
      await expectRenewalLink();
    });

    test("ticketPage hides booking form in read-only mode", () => {
      const listing = testListingWithCount({ attendee_count: 0 });
      const html = ticketPage({
        dates: [],
        listings: [buildTicketListing(listing, false, undefined)],
        slugs: [listing.slug],
      });
      expect(html).toContain("Registration closed.");
      expect(html).not.toContain("Continue");
    });
  },
);

describeWithEnv(
  "read-only warning banner",
  {
    env: {
      READ_ONLY_FROM: new Date(Date.now() + 5 * 86400000).toISOString(),
    },
  },
  () => {
    test("AdminNav shows warning banner before expiry", () => {
      const html = String(
        AdminNav({ active: "/admin/", session: TEST_SESSION }),
      );
      expect(html).toContain("read-only-banner-warning");
      expect(html).toContain("expires on");
    });

    test("AdminNav warning banner includes renewal link when RENEWAL_URL is set", async () => {
      await expectRenewalLink();
    });

    test("AdminNav warning banner falls back when the cutoff date cannot be displayed", () => {
      const original = Date.prototype.toLocaleDateString;
      Date.prototype.toLocaleDateString = () => "";
      try {
        const html = String(
          AdminNav({ active: "/admin/", session: TEST_SESSION }),
        );
        expect(html).toContain("read-only-banner-warning");
        expect(html).toContain("Your site is approaching its expiry");
        expect(html).not.toContain("expires on");
      } finally {
        Date.prototype.toLocaleDateString = original;
      }
    });
  },
);
