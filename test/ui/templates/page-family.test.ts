import { expect } from "@std/expect";
import { afterEach, beforeAll, describe, it as test } from "@std/testing/bdd";
import { Window } from "happy-dom";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { buildForest, buildNavModel } from "#shared/site-pages/core.ts";
import type { TargetMap } from "#shared/site-pages/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import { SuccessCompletePage } from "#templates/components/success-complete-page.tsx";
import { joinErrorPage } from "#templates/join.tsx";
import { type PublicNavProps, publicPage } from "#templates/public/shared.tsx";
import { ticketViewPage } from "#templates/tickets.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testTokenEntry } from "#test-utils/factories.ts";
import {
  navKey,
  navPage as page,
} from "#test-utils/site-pages/nav-fixtures.ts";

/** Which surface each page family covers: admin pages and public pages that
 * share the navigation, the guide's own selector examples, and the setup and
 * join flow pages. */

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

/** Close the windows the tests opened. */
const closeWindows = async (): Promise<void> => {
  await Promise.all(
    parsedWindows.splice(0).map((window) => window.happyDOM.close()),
  );
};

/** Clear the settings the tests changed. */
const reset = (): void => {
  settings.clearTestOverrides();
  setDemoModeForTest(false);
};

/** The selector of each guide example: the part before its rule block. */
const guideExampleSelectors = (): string[] => {
  const selectors: string[] = [];
  for (const match of t("guide.a.custom_css").matchAll(
    /<code>([^<]+)<\/code>/g,
  )) {
    const example = match[1];
    if (example === undefined || !example.startsWith("body[data-page-family")) {
      continue;
    }
    const blockStart = example.indexOf("{");
    selectors.push(
      blockStart === -1 ? example : example.slice(0, blockStart).trim(),
    );
  }
  return selectors;
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

describe("Page family scope", () => {
  beforeAll(setupAdminPageTest);
  afterEach(reset);
  afterEach(closeWindows);

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

describe("System flow families", () => {
  beforeAll(setupAdminPageTest);
  afterEach(reset);
  afterEach(closeWindows);

  test("setup and join completion pages stay system", () => {
    const document = documentFor(
      SuccessCompletePage({
        heading: "Ready to log in",
        loginLink: "Log in",
        messages: ["Your account is ready."],
        title: "Account ready",
      }),
    );

    expect(
      document.querySelector("body")?.getAttribute("data-page-family"),
    ).toBe("system");
  });

  test("an invalid invite page stays system", () => {
    const document = documentFor(joinErrorPage("Expired invite"));

    expect(
      document.querySelector("body")?.getAttribute("data-page-family"),
    ).toBe("system");
  });

  test("the ticket confirmation page stays public", () => {
    const document = documentFor(
      ticketViewPage([{ entry: testTokenEntry(), token: "AABB0011CCDDEEFF" }]),
    );

    expect(
      document.querySelector("body")?.getAttribute("data-page-family"),
    ).toBe("public");
  });
});
