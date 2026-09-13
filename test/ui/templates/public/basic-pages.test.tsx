import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { contactPage, publicSitePage } from "#templates/public/basic-pages.tsx";
import type { PublicNavProps } from "#templates/public/shared.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

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

  test("renders the shared contact email field and message box", () => {
    const html = contactPage({
      botpoisonPublicKey: "",
      formActive: true,
      nav: nav(),
      websiteTitle: "Teeside Walks",
    });

    expect(html).toContain("<title>Contact - Teeside Walks</title>");
    expect(html).toContain("<h2>Send us a message</h2>");
    expect(html).toContain('action="/contact"');
    expect(html).toContain(
      `<label>Your email address<input autocomplete="email" maxlength="${MAX_INPUT_LENGTH}" name="email" required type="email"></label>`,
    );
    expect(html).toContain(
      `<textarea maxlength="${MAX_TEXTAREA_LENGTH}" name="message" required></textarea>`,
    );
    expect(html).toContain(`<button type="submit">Send message</button>`);
  });

  test("loads the contact script only when a botpoison key is configured", () => {
    const withKey = contactPage({
      botpoisonPublicKey: "pk_example",
      formActive: true,
      nav: nav(),
      websiteTitle: "",
    });

    expect(withKey).toContain('<script defer src="/contact.js"></script>');
    expect(withKey).toContain('data-botpoison-public-key="pk_example"');

    const withoutKey = contactPage({
      botpoisonPublicKey: "",
      formActive: true,
      nav: nav(),
      websiteTitle: "",
    });

    expect(withoutKey).not.toContain("/contact.js");
    expect(withoutKey).not.toContain("data-botpoison-public-key");
  });

  test("keeps the form off when the contact form is disabled", () => {
    const html = contactPage({
      botpoisonPublicKey: "",
      formActive: false,
      nav: nav(),
      websiteTitle: "",
    });

    expect(html).toContain("<title>Contact</title>");
    expect(html).not.toContain('action="/contact"');
    expect(html).not.toContain("Send us a message");
  });

  test("shows the site's contact text as markdown prose", () => {
    const html = contactPage({
      botpoisonPublicKey: "",
      content: "## Find us\nCall first.",
      formActive: false,
      nav: nav(),
      websiteTitle: "",
    });

    expect(html).toContain('<div class="prose"><h2>Find us</h2>');
    expect(html).toContain("Call first.");
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

    expect(html).toContain("<title>Home - Teeside Walks</title>");
    expect(html).toContain("<h1>Teeside Walks</h1>");
    expect(html).toContain("<h1>Welcome</h1>");
    expect(html).toContain("Enjoy.");
    expect(html).toContain('href="/admin/login"');
  });

  test("falls back to the bare title and the no-content note", () => {
    const html = publicSitePage("home", nav(), "", "");

    expect(html).toContain("<title>Home</title>");
    expect(html).not.toContain("<title>Home - ");
    expect(html).toContain("<em>No content.</em>");
    expect(html).not.toMatch(/<h1/);
  });

  test("labels the terms page by the site's dictionary title", () => {
    const html = publicSitePage("terms", nav(), "Teeside Walks", "Be kind.");

    expect(html).toContain(
      "<title>Terms &amp; Conditions - Teeside Walks</title>",
    );
  });
});
