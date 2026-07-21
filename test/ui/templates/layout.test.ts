import { expect } from "@std/expect";
import { afterEach, beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  CSS_PATH,
  IFRAME_RESIZER_CHILD_JS_PATH,
  JS_PATH,
} from "#shared/asset-paths.ts";
import { buildTicketListing } from "#shared/booking/model.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  consumeFlash,
  runWithFlashContext,
  setFlashContext,
} from "#shared/flash-context.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import type { AdminSession } from "#shared/types.ts";
import { adminLoginPage } from "#templates/admin/login.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { withStorageDisabled, withStorageEnabled } from "#test-utils/mocks.ts";

const EDITOR_SESSION: AdminSession = { adminLevel: "editor" };

/** Set `RENEWAL_URL`, render `AdminNav`, assert the renewal link is present,
 *  and clean up the env var. Both the read-only and warning-banner describe
 *  blocks repeat this exact sequence. */
const expectRenewalLink = async (): Promise<void> => {
  using _env = withEnv({ RENEWAL_URL: "https://example.com/renew" });
  const html = String(AdminNav({ active: "/admin/", session: OWNER_SESSION }));
  expect(html).toContain("Renew now");
  expect(html).toContain("https://example.com/renew");
};

beforeAll(async () => {
  setupTestEncryptionKey();
  setDemoModeForTest(false);
  await signCsrfToken();
});

afterEach(() => {
  settings.clearTestOverrides();
  setDemoModeForTest(false);
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

  test("pages link /custom.css cache-busted by the settings version", () => {
    const html = adminLoginPage();
    expect(html).toContain(`href="/custom.css?v=${settings.version}"`);
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

  test("keeps global chrome direct while grouping page regions", () => {
    const html = String(
      Layout({
        beforeContent: Raw({ html: '<nav class="example-nav">Menu</nav>' }),
        children: Raw({ html: "<h1>Heading</h1><p>Body</p>" }),
        contentClassName: "example-page",
        title: "Test",
      }),
    );

    expect(html).toContain(
      '<main id="main-content" tabindex="-1"><nav class="example-nav">Menu</nav><div class="page-regions example-page"><h1>Heading</h1><p>Body</p></div></main>',
    );
  });
});

describe("Layout document shell", () => {
  test("renders the required document metadata and stylesheet contracts", () => {
    const html = String(Layout({ children: "", title: "Test" }));

    expect(html.slice(0, "<!DOCTYPE html>".length)).toBe("<!DOCTYPE html>");
    expect(html).toContain(
      '<meta charset="UTF-8"><meta content="width=device-width, initial-scale=1.0" name="viewport">',
    );
    expect(html).toContain(`<link href="${CSS_PATH}" rel="stylesheet">`);
    expect(html).toContain(
      `<link href="/custom.css?v=${settings.version}" rel="stylesheet">`,
    );
  });

  test("renders head extras as markup", () => {
    const extra = '<meta content="raw" name="test-extra">';
    const html = String(
      Layout({ children: "", headExtra: extra, title: "Test" }),
    );

    expect(html).toContain(extra);
    expect(html).not.toContain("&lt;meta");
  });

  test("applies an explicit body class without adding the iframe script", () => {
    const html = String(
      Layout({ bodyClass: "example-page", children: "", title: "Test" }),
    );

    expect(html).toContain('<body class="example-page">');
    expect(html).not.toContain(IFRAME_RESIZER_CHILD_JS_PATH);
  });

  test("adds the iframe script only for an iframe body class", () => {
    const html = String(
      Layout({ bodyClass: "example iframe", children: "", title: "Test" }),
    );

    expect(html).toContain('<body class="example iframe">');
    expect(html).toContain(
      `<script src="${IFRAME_RESIZER_CHILD_JS_PATH}"></script>`,
    );
  });

  test("renders the configured header image with decorative semantics", () => {
    settings.setForTest({ header_image_url: "header.jpg" });
    const html = String(Layout({ children: "", title: "Test" }));

    expect(html).toContain(
      `<img alt="" class="header-image" src="${getImageProxyUrl("header.jpg")}">`,
    );
  });

  test("renders the demo banner only in demo mode", () => {
    const normalHtml = String(Layout({ children: "", title: "Test" }));
    setDemoModeForTest(true);
    const demoHtml = String(Layout({ children: "", title: "Test" }));

    expect(normalHtml).not.toContain('class="demo-banner"');
    expect(demoHtml).toContain('class="demo-banner"');
  });

  test("renders an unconsumed request flash before the page content", () => {
    const html = runWithFlashContext(() => {
      setFlashContext({ success: "Saved from context" });
      return String(Layout({ children: "Page body", title: "Test" }));
    });

    expect(html).toContain(
      '<div class="success" role="alert">Saved from context</div><div class="page-regions">Page body</div>',
    );
  });

  test("does not repeat a consumed request flash", () => {
    const html = runWithFlashContext(() => {
      setFlashContext({ error: "Already shown" });
      consumeFlash();
      return String(Layout({ children: "Page body", title: "Test" }));
    });

    expect(html).not.toContain("Already shown");
    expect(html).toContain('<div class="page-regions">Page body</div>');
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

describe("AdminNav image storage gating", () => {
  test("shows Images only when file storage is enabled", () => {
    const hasImagesLink = (session: AdminSession): boolean =>
      String(AdminNav({ active: "/admin/", session })).includes(
        'href="/admin/images"',
      );

    withStorageEnabled(() => {
      expect(hasImagesLink(OWNER_SESSION)).toBe(true);
      expect(hasImagesLink(EDITOR_SESSION)).toBe(true);
    });
    withStorageDisabled(() => {
      expect(hasImagesLink(OWNER_SESSION)).toBe(false);
      expect(hasImagesLink(EDITOR_SESSION)).toBe(false);
    });
  });
});

describeWithEnv(
  "read-only mode templates",
  { env: { READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" } },
  () => {
    test("AdminNav shows read-only banner", () => {
      const html = String(
        AdminNav({ active: "/admin/", session: OWNER_SESSION }),
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
        AdminNav({ active: "/admin/", session: OWNER_SESSION }),
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
          AdminNav({ active: "/admin/", session: OWNER_SESSION }),
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
