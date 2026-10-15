import { assert } from "@std/assert";
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
import { inputNamed } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { says } from "#test-utils/says.ts";
import { enableFeature } from "#test-utils/settings.ts";

describeWithEnv("site editor pages", { db: true }, () => {
  beforeAll(setupAdminPageTest);

  test("the home page shows both boxes carrying the stored values", () => {
    const html = adminSiteHomePage(OWNER_SESSION, "My site", "Welcome!");
    says(html, 'value="My site"');
    says(html, "Welcome!");
    says(html, 'name="website_title"');
    says(html, 'name="homepage_text"');
    says(html, 'action="/admin/site"');
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
      says(html, 'href="/admin/guide#public-site"');
    }
  });

  test("the contact page shows its text box, its toggle, and the spam note", () => {
    const html = adminSiteContactPage(OWNER_SESSION, "Email us", {
      botpoisonEnabled: false,
      enabled: false,
      hasBusinessEmail: true,
    });
    says(html, "Email us");
    says(html, 'name="contact_page_text"');
    says(html, 'action="/admin/site/contact"');
    // The toggle posts to its own route with a checkbox the route reads.
    says(html, 'action="/admin/site/contact/form"');
    const toggle = inputNamed(html, "contact_form_enabled");
    says(toggle, 'type="checkbox"');
    says(toggle, 'value="true"');
    // The box and its label stay one space apart, not glued.
    expect(html).toMatch(
      /name="contact_form_enabled"[^>]*>\s+Enable contact form/,
    );
    says(html, "submissions are accepted without a spam check");
    assert(!html.includes("to receive contact form messages"));
    // The env-key names sit one space apart, not glued.
    says(html, "and <code>BOTPOISON_SECRET_KEY</code>");
    says(html, 'class="prose"');
  });

  test("the contact page names Botpoison when it is active", () => {
    const html = adminSiteContactPage(OWNER_SESSION, "", {
      botpoisonEnabled: true,
      enabled: false,
      hasBusinessEmail: true,
    });
    says(html, "Botpoison is active.");
    assert(!html.includes("without a spam check"));
  });

  test("the contact page asks for a business email when none is set", () => {
    const html = adminSiteContactPage(OWNER_SESSION, "", {
      botpoisonEnabled: false,
      enabled: false,
      hasBusinessEmail: false,
    });
    says(html, "to receive contact form messages");
  });

  test("the order page shows the intro box and the enable toggle", () => {
    const html = adminSiteOrderPage(OWNER_SESSION, "Before you book, note:", {
      enabled: false,
      listingCount: 2,
    });
    says(html, "Before you book, note:");
    says(html, 'name="order_intro_text"');
    says(html, 'action="/admin/site/order"');
    says(html, 'action="/admin/site/order/toggle"');
    const toggle = inputNamed(html, "order_enabled");
    says(toggle, 'type="checkbox"');
    says(toggle, 'value="true"');
    // The box and its label stay one space apart, not glued.
    expect(html).toMatch(/name="order_enabled"[^>]*>\s+Enable order page/);
    says(html, 'class="prose"');
  });

  test("the order page counts the listings it will show", () => {
    const two = adminSiteOrderPage(OWNER_SESSION, "", {
      enabled: false,
      listingCount: 2,
    });
    says(two, "2 listings will be shown on the order page.");
    const one = adminSiteOrderPage(OWNER_SESSION, "", {
      enabled: false,
      listingCount: 1,
    });
    says(one, "1 listing will be shown on the order page.");
  });

  test("the order page warns when no listing can appear yet", () => {
    const html = adminSiteOrderPage(OWNER_SESSION, "", {
      enabled: false,
      listingCount: 0,
    });
    says(html, "You have no bookable listings yet.");
    // The warning's own link, with its words one space apart.
    says(html, 'href="/admin/">Create a listing</a> for it');
    assert(!html.includes("will be shown on the order page"));
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
      says(html, '<a class="active" href="/admin/site">');
    }
  });
});
