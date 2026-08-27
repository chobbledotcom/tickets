import { expect } from "@std/expect";
import { beforeAll, it as test } from "@std/testing/bdd";
import {
  adminSiteContactPage,
  adminSiteHomePage,
  adminSiteOrderPage,
} from "#templates/admin/site.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { enableFeature } from "#test-utils/settings.ts";

describeWithEnv("site editor pages", { db: true }, () => {
  beforeAll(setupAdminPageTest);

  test("the home page shows both boxes carrying the stored values", () => {
    const html = adminSiteHomePage(OWNER_SESSION, "My site", "Welcome!");
    expect(html).toContain('value="My site"');
    expect(html).toContain("Welcome!");
    expect(html).toContain('name="website_title"');
    expect(html).toContain('name="homepage_text"');
    expect(html).toContain('action="/admin/site"');
  });

  test("every site editor page links its guide chapter", () => {
    const pages = [
      adminSiteHomePage(OWNER_SESSION, "", ""),
      adminSiteContactPage(OWNER_SESSION, "", {
        botpoisonEnabled: false,
        enabled: false,
        hasBusinessEmail: true,
      }),
      adminSiteOrderPage(OWNER_SESSION, "", {
        enabled: false,
        listingCount: 0,
      }),
    ];
    for (const html of pages) {
      expect(html).toContain('href="/admin/guide#public-site"');
    }
  });

  test("the contact page shows its text box, its toggle, and the spam note", () => {
    const html = adminSiteContactPage(OWNER_SESSION, "Email us", {
      botpoisonEnabled: false,
      enabled: false,
      hasBusinessEmail: true,
    });
    expect(html).toContain("Email us");
    expect(html).toContain('name="contact_page_text"');
    expect(html).toContain('action="/admin/site/contact"');
    // The toggle posts to its own route with a checkbox the route reads.
    expect(html).toContain('action="/admin/site/contact/form"');
    const toggle = html.slice(
      html.indexOf('name="contact_form_enabled"') - 100,
      html.indexOf('name="contact_form_enabled"') + 100,
    );
    expect(toggle).toContain('type="checkbox"');
    expect(toggle).toContain('value="true"');
    expect(html).toContain("submissions are accepted without a spam check");
    expect(html).not.toContain("to receive contact form messages");
    // The env-key names sit one space apart, not glued.
    expect(html).toContain("and <code>BOTPOISON_SECRET_KEY</code>");
    expect(html).toContain('class="prose"');
  });

  test("the contact page names Botpoison when it is active", () => {
    const html = adminSiteContactPage(OWNER_SESSION, "", {
      botpoisonEnabled: true,
      enabled: false,
      hasBusinessEmail: true,
    });
    expect(html).toContain("Botpoison is active.");
    expect(html).not.toContain("without a spam check");
  });

  test("the contact page asks for a business email when none is set", () => {
    const html = adminSiteContactPage(OWNER_SESSION, "", {
      botpoisonEnabled: false,
      enabled: false,
      hasBusinessEmail: false,
    });
    expect(html).toContain("to receive contact form messages");
  });

  test("the order page shows the intro box and the enable toggle", () => {
    const html = adminSiteOrderPage(OWNER_SESSION, "Before you book, note:", {
      enabled: false,
      listingCount: 2,
    });
    expect(html).toContain("Before you book, note:");
    expect(html).toContain('name="order_intro_text"');
    expect(html).toContain('action="/admin/site/order"');
    expect(html).toContain('action="/admin/site/order/toggle"');
    const toggle = html.slice(
      html.indexOf('name="order_enabled"') - 100,
      html.indexOf('name="order_enabled"') + 100,
    );
    expect(toggle).toContain('type="checkbox"');
    expect(toggle).toContain('value="true"');
    expect(html).toContain('class="prose"');
  });

  test("the order page counts the listings it will show", () => {
    const two = adminSiteOrderPage(OWNER_SESSION, "", {
      enabled: false,
      listingCount: 2,
    });
    expect(two).toContain("2 listings will be shown on the order page.");
    const one = adminSiteOrderPage(OWNER_SESSION, "", {
      enabled: false,
      listingCount: 1,
    });
    expect(one).toContain("1 listing will be shown on the order page.");
  });

  test("the order page warns when no listing can appear yet", () => {
    const html = adminSiteOrderPage(OWNER_SESSION, "", {
      enabled: false,
      listingCount: 0,
    });
    expect(html).toContain("You have no bookable listings yet.");
    // The warning's own link, with its words one space apart.
    expect(html).toContain('href="/admin/">Create a listing</a> for it');
    expect(html).not.toContain("will be shown on the order page");
  });

  test("each editor opens the Site nav section with its landing link lit", async () => {
    await enableFeature("site");
    for (const html of [
      adminSiteHomePage(OWNER_SESSION, "", ""),
      adminSiteContactPage(OWNER_SESSION, "", {
        botpoisonEnabled: false,
        enabled: false,
        hasBusinessEmail: true,
      }),
      adminSiteOrderPage(OWNER_SESSION, "", {
        enabled: false,
        listingCount: 1,
      }),
    ]) {
      expect(html).toContain('<a class="active" href="/admin/site">');
    }
  });
});
