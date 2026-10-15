import { assert, assertStringIncludes } from "@std/assert";
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
import { enableFeature } from "#test-utils/settings.ts";

describeWithEnv("site editor pages", { db: true }, () => {
  beforeAll(setupAdminPageTest);

  test("the home page shows both boxes carrying the stored values", () => {
    const html = adminSiteHomePage(OWNER_SESSION, "My site", "Welcome!");
    assertStringIncludes(html, 'value="My site"');
    assertStringIncludes(html, "Welcome!");
    assertStringIncludes(html, 'name="website_title"');
    assertStringIncludes(html, 'name="homepage_text"');
    assertStringIncludes(html, 'action="/admin/site"');
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
      assertStringIncludes(html, 'href="/admin/guide#public-site"');
    }
  });

  test("the contact page shows its text box, its toggle, and the spam note", () => {
    const html = adminSiteContactPage(OWNER_SESSION, "Email us", {
      botpoisonEnabled: false,
      enabled: false,
      hasBusinessEmail: true,
    });
    assertStringIncludes(html, "Email us");
    assertStringIncludes(html, 'name="contact_page_text"');
    assertStringIncludes(html, 'action="/admin/site/contact"');
    // The toggle posts to its own route with a checkbox the route reads.
    assertStringIncludes(html, 'action="/admin/site/contact/form"');
    const toggle = inputNamed(html, "contact_form_enabled");
    assertStringIncludes(toggle, 'type="checkbox"');
    assertStringIncludes(toggle, 'value="true"');
    // The box and its label stay one space apart, not glued.
    expect(html).toMatch(
      /name="contact_form_enabled"[^>]*>\s+Enable contact form/,
    );
    assertStringIncludes(html, "submissions are accepted without a spam check");
    assert(
      !html.includes("to receive contact form messages"),
      "the value should not contain the searched item",
    );
    // The env-key names sit one space apart, not glued.
    assertStringIncludes(html, "and <code>BOTPOISON_SECRET_KEY</code>");
    assertStringIncludes(html, 'class="prose"');
  });

  test("the contact page names Botpoison when it is active", () => {
    const html = adminSiteContactPage(OWNER_SESSION, "", {
      botpoisonEnabled: true,
      enabled: false,
      hasBusinessEmail: true,
    });
    assertStringIncludes(html, "Botpoison is active.");
    assert(
      !html.includes("without a spam check"),
      "the value should not contain the searched item",
    );
  });

  test("the contact page asks for a business email when none is set", () => {
    const html = adminSiteContactPage(OWNER_SESSION, "", {
      botpoisonEnabled: false,
      enabled: false,
      hasBusinessEmail: false,
    });
    assertStringIncludes(html, "to receive contact form messages");
  });

  test("the order page shows the intro box and the enable toggle", () => {
    const html = adminSiteOrderPage(OWNER_SESSION, "Before you book, note:", {
      enabled: false,
      listingCount: 2,
    });
    assertStringIncludes(html, "Before you book, note:");
    assertStringIncludes(html, 'name="order_intro_text"');
    assertStringIncludes(html, 'action="/admin/site/order"');
    assertStringIncludes(html, 'action="/admin/site/order/toggle"');
    const toggle = inputNamed(html, "order_enabled");
    assertStringIncludes(toggle, 'type="checkbox"');
    assertStringIncludes(toggle, 'value="true"');
    // The box and its label stay one space apart, not glued.
    expect(html).toMatch(/name="order_enabled"[^>]*>\s+Enable order page/);
    assertStringIncludes(html, 'class="prose"');
  });

  test("the order page counts the listings it will show", () => {
    const two = adminSiteOrderPage(OWNER_SESSION, "", {
      enabled: false,
      listingCount: 2,
    });
    assertStringIncludes(two, "2 listings will be shown on the order page.");
    const one = adminSiteOrderPage(OWNER_SESSION, "", {
      enabled: false,
      listingCount: 1,
    });
    assertStringIncludes(one, "1 listing will be shown on the order page.");
  });

  test("the order page warns when no listing can appear yet", () => {
    const html = adminSiteOrderPage(OWNER_SESSION, "", {
      enabled: false,
      listingCount: 0,
    });
    assertStringIncludes(html, "You have no bookable listings yet.");
    // The warning's own link, with its words one space apart.
    assertStringIncludes(html, 'href="/admin/">Create a listing</a> for it');
    assert(
      !html.includes("will be shown on the order page"),
      "the value should not contain the searched item",
    );
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
      assertStringIncludes(html, '<a class="active" href="/admin/site">');
    }
  });
});
