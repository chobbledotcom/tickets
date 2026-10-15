import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { contactPage, publicSitePage } from "#templates/public/basic-pages.tsx";
import type { PublicNavProps } from "#templates/public/shared.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { says } from "#test-utils/says.ts";

/** The nav a public page test needs: fixed links on, no operator pages. */
const nav = (): PublicNavProps => ({
  hasContact: true,
  hasNews: false,
  hasOrder: false,
  hasTerms: true,
  pages: {
    activeRootId: null,
    currentChildren: [],
    rootPageNodes: [],
    submenuLevels: [],
  },
});

describe("the public contact page", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders the shared contact email field and message box", async () => {
    // A per-request saved-form slot: another suite's contact POST cannot
    // leave an "email" value behind, so the echo would appear here if the
    // slot leaked across requests.
    const html = await withRequestContext(() =>
      contactPage({
        botpoisonPublicKey: "",
        formActive: true,
        nav: nav(),
        websiteTitle: "Teeside Walks",
      }),
    );

    says(html, "<title>Contact - Teeside Walks</title>");
    says(html, "<h2>Send us a message</h2>");
    says(html, 'action="/contact"');
    says(
      html,
      `<label>Your email address<input autocomplete="email" maxlength="${MAX_INPUT_LENGTH}" name="email" required type="email"></label>`,
    );
    says(
      html,
      `<textarea maxlength="${MAX_TEXTAREA_LENGTH}" name="message" required></textarea>`,
    );
    says(html, `<button type="submit">Send message</button>`);
  });

  test("loads the contact script only when a botpoison key is configured", () => {
    const withKey = contactPage({
      botpoisonPublicKey: "pk_example",
      formActive: true,
      nav: nav(),
      websiteTitle: "",
    });

    says(withKey, '<script defer src="/contact.js"></script>');
    says(withKey, 'data-botpoison-public-key="pk_example"');

    const withoutKey = contactPage({
      botpoisonPublicKey: "",
      formActive: true,
      nav: nav(),
      websiteTitle: "",
    });

    assert(!withoutKey.includes("/contact.js"));
    assert(!withoutKey.includes("data-botpoison-public-key"));
  });

  test("keeps the form off when the contact form is disabled", () => {
    const html = contactPage({
      botpoisonPublicKey: "",
      formActive: false,
      nav: nav(),
      websiteTitle: "",
    });

    says(html, "<title>Contact</title>");
    assert(!html.includes('action="/contact"'));
    assert(!html.includes("Send us a message"));
  });

  test("shows the site's contact text as markdown prose", () => {
    const html = contactPage({
      botpoisonPublicKey: "",
      content: "## Find us\nCall first.",
      formActive: false,
      nav: nav(),
      websiteTitle: "",
    });

    says(html, '<div class="prose"><h2>Find us</h2>');
    says(html, "Call first.");
  });
});

describe("the public home page", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders the site title, its content, and the login footer", () => {
    const html = publicSitePage(
      "home",
      nav(),
      "Teeside Walks",
      "# Welcome\nEnjoy.",
    );

    says(html, "<title>Home - Teeside Walks</title>");
    says(html, "<h1>Teeside Walks</h1>");
    says(html, "<h1>Welcome</h1>");
    says(html, "Enjoy.");
    says(html, 'href="/admin/login"');
  });

  test("falls back to the bare title and the no-content note", () => {
    const html = publicSitePage("home", nav(), "", "");

    says(html, "<title>Home</title>");
    assert(!html.includes("<title>Home - "));
    says(html, "<em>No content.</em>");
    expect(html).not.toMatch(/<h1/);
  });

  test("labels the terms page by the site's dictionary title", () => {
    const html = publicSitePage("terms", nav(), "Teeside Walks", "Be kind.");

    says(html, "<title>Terms &amp; Conditions - Teeside Walks</title>");
  });
});
