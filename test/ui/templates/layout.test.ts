import { expect } from "@std/expect";
import { afterEach, beforeAll, describe, it as test } from "@std/testing/bdd";
import { Window } from "happy-dom";
import { buildTicketListing } from "#booking/model.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import {
  CSS_PATH,
  IFRAME_RESIZER_CHILD_JS_PATH,
  JS_PATH,
} from "#shared/asset-paths.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { consumeFlash, setFlashContext } from "#shared/flash-context.ts";
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";
import { detectIframeMode } from "#shared/request-context.ts";
import { buildForest, buildNavModel } from "#shared/site-pages/core.ts";
import type { TargetMap } from "#shared/site-pages/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import { adminLoginPage } from "#templates/admin/login.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import { type PublicNavProps, publicPage } from "#templates/public/shared.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { withStorageDisabled, withStorageEnabled } from "#test-utils/mocks.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import {
  navKey,
  navPage as page,
} from "#test-utils/site-pages/nav-fixtures.ts";
import type { AdminSession } from "#types";

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

const setupLayoutTest = async (): Promise<void> => {
  await setupAdminPageTest();
  setDemoModeForTest(false);
};

const resetLayoutTest = (): void => {
  settings.clearTestOverrides();
  setDemoModeForTest(false);
};

describe("asset-paths", () => {
  beforeAll(setupLayoutTest);
  afterEach(resetLayoutTest);

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
  beforeAll(setupLayoutTest);
  afterEach(resetLayoutTest);

  test("renders skip-nav link targeting main-content", () => {
    const html = String(
      Layout({ children: "", family: "public", title: "Test" }),
    );
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
        family: "public",
        title: "Test",
      }),
    );

    expect(html).toContain(
      '<main id="main-content" tabindex="-1"><nav class="example-nav">Menu</nav><div class="page-regions example-page"><h1>Heading</h1><p>Body</p></div></main>',
    );
  });
});

describe("Layout document shell", () => {
  beforeAll(setupLayoutTest);
  afterEach(resetLayoutTest);

  test("renders the required document metadata and stylesheet contracts", () => {
    const html = String(
      Layout({ children: "", family: "public", title: "Test" }),
    );

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
      Layout({
        children: "",
        family: "public",
        headExtra: extra,
        title: "Test",
      }),
    );

    expect(html).toContain(extra);
    expect(html).not.toContain("&lt;meta");
  });

  test("applies an explicit body class without adding the iframe script", () => {
    const html = String(
      Layout({
        bodyClass: "example-page",
        children: "",
        family: "public",
        title: "Test",
      }),
    );

    expect(html).toContain(
      '<body class="example-page" data-page-family="public">',
    );
    expect(html).not.toContain(IFRAME_RESIZER_CHILD_JS_PATH);
  });

  test("adds the iframe script only for an iframe body class", () => {
    const html = String(
      Layout({
        bodyClass: "example iframe",
        children: "",
        family: "public",
        title: "Test",
      }),
    );

    expect(html).toContain(
      '<body class="example iframe" data-page-family="public">',
    );
    expect(html).toContain(
      `<script src="${IFRAME_RESIZER_CHILD_JS_PATH}"></script>`,
    );
  });

  test("renders the configured header image with decorative semantics", () => {
    settings.setForTest({ header_image_url: "header.jpg" });
    const html = String(
      Layout({ children: "", family: "public", title: "Test" }),
    );

    expect(html).toContain(
      `<img alt="" class="header-image" src="${getImageProxyUrl(
        "header.jpg",
      )}">`,
    );
  });

  test("hides the configured header image in iframe mode", async () => {
    settings.setForTest({ header_image_url: "header.jpg" });
    const html = await withRequestContext(() => {
      detectIframeMode(new URL("https://example.com/?iframe=true"));
      return String(Layout({ children: "", family: "public", title: "Test" }));
    });

    expect(html).not.toContain("header-image");
    expect(html).not.toContain(getImageProxyUrl("header.jpg"));
  });

  test("renders the demo banner only in demo mode", () => {
    const normalHtml = String(
      Layout({ children: "", family: "public", title: "Test" }),
    );
    setDemoModeForTest(true);
    const demoHtml = String(
      Layout({ children: "", family: "public", title: "Test" }),
    );

    expect(normalHtml).not.toContain('class="demo-banner"');
    expect(demoHtml).toContain('class="demo-banner"');
  });

  test("renders an unconsumed request flash before the page content", async () => {
    const html = await withRequestContext(() => {
      setFlashContext({ success: "Saved from context" });
      return String(
        Layout({ children: "Page body", family: "public", title: "Test" }),
      );
    });

    expect(html).toContain(
      '<div class="success" role="alert">Saved from context</div><div class="page-regions">Page body</div>',
    );
  });

  test("does not repeat a consumed request flash", async () => {
    const html = await withRequestContext(() => {
      setFlashContext({ error: "Already shown" });
      consumeFlash();
      return String(
        Layout({ children: "Page body", family: "public", title: "Test" }),
      );
    });

    expect(html).not.toContain("Already shown");
    expect(html).toContain('<div class="page-regions">Page body</div>');
  });
});

describe("Page family scope", () => {
  beforeAll(setupLayoutTest);
  afterEach(resetLayoutTest);
  afterEach(async () => {
    await Promise.all(
      parsedWindows.splice(0).map((window) => window.happyDOM.close()),
    );
  });

  /** Parsed full-page documents, closed again after each test. */
  const parsedWindows: Window[] = [];

  /** Parse a rendered page into a happy-dom document for selector matching. */
  const documentFor = (html: string) => {
    const window = new Window({
      settings: {
        disableCSSFileLoading: true,
        disableJavaScriptEvaluation: true,
        disableJavaScriptFileLoading: true,
      },
      url: "https://layout.test/",
    });
    window.document.write(html);
    parsedWindows.push(window);
    return window.document;
  };

  /** An admin page with the shared navigation. */
  const adminDocument = () =>
    documentFor(
      String(
        AdminPage({
          active: "/admin/",
          children: "",
          session: OWNER_SESSION,
          title: "Admin",
        }),
      ),
    );

  /** A public page with the shared navigation. */
  const publicDocument = () => {
    const forest = buildForest([page(1)], []);
    const nav: PublicNavProps = {
      hasContact: false,
      hasNews: false,
      hasOrder: false,
      hasTerms: true,
      pages: buildNavModel(forest, new Map() as TargetMap, navKey("page", 1)),
    };
    return documentFor(publicPage("Welcome", "", nav)(""));
  };

  /** The selector of each guide example: the part before its rule block. */
  const guideExampleSelectors = (): string[] => {
    const selectors: string[] = [];
    for (const match of t("guide.a.custom_css").matchAll(
      /<code>([^<]+)<\/code>/g,
    )) {
      const example = match[1];
      if (
        example === undefined ||
        !example.startsWith("body[data-page-family")
      ) {
        continue;
      }
      const blockStart = example.indexOf("{");
      selectors.push(
        blockStart === -1 ? example : example.slice(0, blockStart).trim(),
      );
    }
    return selectors;
  };

  test("an admin page scopes the shared nav to admin", () => {
    const document = adminDocument();

    expect(
      document.querySelector("body")?.getAttribute("data-page-family"),
    ).toBe("admin");
    expect(
      document.querySelector('body[data-page-family="admin"] .admin-nav-group'),
    ).not.toBeNull();
    expect(
      document.querySelector('body[data-page-family="public"]'),
    ).toBeNull();
  });

  test("a public page scopes the shared nav to public", () => {
    const document = publicDocument();

    expect(
      document.querySelector("body")?.getAttribute("data-page-family"),
    ).toBe("public");
    expect(
      document.querySelector(
        'body[data-page-family="public"] .admin-nav-group',
      ),
    ).not.toBeNull();
    expect(document.querySelector('body[data-page-family="admin"]')).toBeNull();
  });

  test("the guide examples each match only their own surface", () => {
    const admin = adminDocument();
    const visitor = publicDocument();
    const selectors = guideExampleSelectors();

    expect(selectors.some((selector) => selector.includes('"admin"'))).toBe(
      true,
    );
    expect(selectors.some((selector) => selector.includes('"public"'))).toBe(
      true,
    );

    for (const selector of selectors) {
      const onAdmin = admin.querySelector(selector) !== null;
      const onPublic = visitor.querySelector(selector) !== null;
      if (selector.includes('"admin"')) {
        expect(onAdmin).toBe(true);
        expect(onPublic).toBe(false);
      } else {
        expect(onPublic).toBe(true);
        expect(onAdmin).toBe(false);
      }
    }
  });
});

describe("adminLoginPage", () => {
  beforeAll(setupLayoutTest);
  afterEach(resetLayoutTest);

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
  beforeAll(setupLayoutTest);
  afterEach(resetLayoutTest);

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
    beforeAll(setupLayoutTest);
    afterEach(resetLayoutTest);

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
    beforeAll(setupLayoutTest);
    afterEach(resetLayoutTest);

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
