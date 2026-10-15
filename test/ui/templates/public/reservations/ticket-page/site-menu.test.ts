import { assert } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { detectIframeMode } from "#shared/request-context.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import type { PublicNavProps } from "#templates/public/shared.tsx";
import {
  registerPublicTemplateHooks,
  ticketListing,
} from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { says } from "#test-utils/says.ts";

/** A minimal public-nav prop set — the fixed root links only, no page tree. */
const navProps = (): PublicNavProps => ({
  hasContact: false,
  hasNews: false,
  hasOrder: false,
  hasTerms: false,
  pages: {
    activeRootId: null,
    currentChildren: [],
    rootPageNodes: [],
    submenuLevels: [],
  },
});

describe("ticketPage (site menu)", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("shows the site menu above the form on a normal page", () => {
    const html = ticketPage({
      listings: [ticketListing({ name: "Listing" })],
      nav: navProps(),
      slugs: ["listing"],
    });
    says(html, '<div class="admin-nav-group">');
    says(html, 'aria-label="Site menu"');
    says(html, '<a href="/listings">');
  });

  test("drops the site menu in iframe mode even when one is supplied", async () => {
    await withRequestContext(() => {
      detectIframeMode(new URL("https://example.com/?iframe=true"));
      const html = ticketPage({
        listings: [ticketListing({ name: "Listing" })],
        nav: navProps(),
        slugs: ["listing"],
      });
      says(html, '<body class="iframe" data-page-family="public">');
      assert(!html.includes("admin-nav-group"));
      assert(!html.includes('aria-label="Site menu"'));
    });
  });
});
