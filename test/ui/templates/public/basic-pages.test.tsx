import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";

import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { contactPage, publicSitePage } from "#templates/public/basic-pages.tsx";
import type { PublicNavProps } from "#templates/public/shared.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

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

    assertStringIncludes(html, "<title>Contact - Teeside Walks</title>");
    assertStringIncludes(html, "<h2>Send us a message</h2>");
    assertStringIncludes(html, 'action="/contact"');
    assertStringIncludes(
      html,
      `<label>Your email address<input autocomplete="email" maxlength="${MAX_INPUT_LENGTH}" name="email" required type="email"></label>`,
    );
    assertStringIncludes(
      html,
      `<textarea maxlength="${MAX_TEXTAREA_LENGTH}" name="message" required></textarea>`,
    );
    assertStringIncludes(html, `<button type="submit">Send message</button>`);
  });

  test("loads the contact script only when a botpoison key is configured", () => {
    const withKey = contactPage({
      botpoisonPublicKey: "pk_example",
      formActive: true,
      nav: nav(),
      websiteTitle: "",
    });

    assertStringIncludes(withKey, '<script defer src="/contact.js"></script>');
    assertStringIncludes(withKey, 'data-botpoison-public-key="pk_example"');

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

    assertStringIncludes(html, "<title>Contact</title>");
    assert(!html.includes('action="/contact"'));
    assert(!html.includes("Send us a message"));
  });

  test("prefixes the contact title with the site title", () => {
    const html = contactPage({
      botpoisonPublicKey: "",
      formActive: false,
      nav: nav(),
      websiteTitle: "Teeside Walks",
    });

    assertStringIncludes(html, "<title>Contact - Teeside Walks</title>");
  });

  test("shows the site's contact text as markdown prose", () => {
    const html = contactPage({
      botpoisonPublicKey: "",
      content: "## Find us\nCall first.",
      formActive: false,
      nav: nav(),
      websiteTitle: "",
    });

    assertStringIncludes(html, '<div class="prose"><h2>Find us</h2>');
    assertStringIncludes(html, "Call first.");
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

    assertStringIncludes(html, "<title>Teeside Walks</title>");
    assert(!html.includes("<title>Home"));
    assertStringIncludes(html, "<h1>Teeside Walks</h1>");
    assertStringIncludes(html, "<h1>Welcome</h1>");
    assertStringIncludes(html, "Enjoy.");
    assertStringIncludes(html, 'href="/admin/login"');
  });

  test("falls back to the bare title and the no-content note", () => {
    const html = publicSitePage("home", nav(), "", "");

    assertStringIncludes(html, "<title>Home</title>");
    assert(!html.includes("<title>Home - "));
    assertStringIncludes(html, "<em>No content.</em>");
    expect(html).not.toMatch(/<h1/);
  });

  test("labels the terms page by the site's dictionary title", () => {
    const html = publicSitePage("terms", nav(), "Teeside Walks", "Be kind.");

    assertStringIncludes(
      html,
      "<title>Terms &amp; Conditions - Teeside Walks</title>",
    );
  });
});
