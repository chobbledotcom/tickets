import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminSiteContactPage,
  adminSiteHomePage,
  adminSiteOrderPage,
} from "#templates/admin/site.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

describe("site editor pages", () => {
  beforeAll(setupAdminPageTest);

  test("the home page shows both boxes carrying the stored values", () => {
    const html = adminSiteHomePage(OWNER_SESSION, "My site", "Welcome!");
    expect(html).toContain('value="My site"');
    expect(html).toContain("Welcome!");
    expect(html).toContain('name="website_title"');
    expect(html).toContain('name="homepage_text"');
  });

  test("the contact page shows its text box and the form toggle", () => {
    const html = adminSiteContactPage(OWNER_SESSION, "Email us", {
      botpoisonEnabled: false,
      enabled: false,
      hasBusinessEmail: true,
    });
    expect(html).toContain("Email us");
    expect(html).toContain('name="contact_page_text"');
    expect(html).toContain('name="contact_form_enabled"');
    expect(html).not.toContain("to receive contact form messages");
  });

  test("the contact page asks for a business email when none is set", () => {
    const html = adminSiteContactPage(OWNER_SESSION, "", {
      botpoisonEnabled: false,
      enabled: false,
      hasBusinessEmail: false,
    });
    expect(html).toContain("to receive contact form messages");
  });

  test("the order page shows the intro box, the toggle, and the count note", () => {
    const html = adminSiteOrderPage(OWNER_SESSION, "Before you book, note:", {
      enabled: false,
      listingCount: 2,
    });
    expect(html).toContain("Before you book, note:");
    expect(html).toContain('name="order_intro_text"');
    expect(html).toContain('name="order_enabled"');
  });
});
