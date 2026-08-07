import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { detectIframeMode } from "#shared/iframe.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import type { PublicNavProps } from "#templates/public/shared.tsx";
import {
  registerPublicTemplateHooks,
  ticketListing,
} from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

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
    expect(html).toContain('<div class="admin-nav-group">');
    expect(html).toContain('aria-label="Site menu"');
    expect(html).toContain('<a href="/listings">');
  });

  test("drops the site menu in iframe mode even when one is supplied", () => {
    detectIframeMode(new URL("https://example.com/?iframe=true"));
    const html = ticketPage({
      listings: [ticketListing({ name: "Listing" })],
      nav: navProps(),
      slugs: ["listing"],
    });
    expect(html).toContain('<body class="iframe">');
    expect(html).not.toContain("admin-nav-group");
    expect(html).not.toContain('aria-label="Site menu"');
  });
});
