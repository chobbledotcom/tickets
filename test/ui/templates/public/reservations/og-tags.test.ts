import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { buildOgTags } from "#templates/public/reservations/og-tags.ts";

import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("buildOgTags", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("includes title, type, and url", () => {
    const html = buildOgTags(
      {
        description: "",
        image_url: "",
        name: "My Listing",
        slug: "my-listing",
      },
      "https://example.com",
    );
    assertStringIncludes(
      html,
      '<meta property="og:title" content="My Listing">',
    );
    assertStringIncludes(html, '<meta property="og:type" content="website">');
    assertStringIncludes(
      html,
      '<meta property="og:url" content="https://example.com/ticket/my-listing">',
    );
  });

  test("includes description when present", () => {
    const html = buildOgTags(
      {
        description: "Come join us",
        image_url: "",
        name: "My Listing",
        slug: "my-listing",
      },
      "https://example.com",
    );
    assertStringIncludes(
      html,
      '<meta property="og:description" content="Come join us">',
    );
  });

  test("excludes description when empty", () => {
    const html = buildOgTags(
      {
        description: "",
        image_url: "",
        name: "My Listing",
        slug: "my-listing",
      },
      "https://example.com",
    );
    assert(
      !html.includes("og:description"),
      "the value should not contain the searched item",
    );
  });

  test("includes image when present", () => {
    const html = buildOgTags(
      {
        description: "",
        image_url: "photo.jpg",
        name: "My Listing",
        slug: "my-listing",
      },
      "https://example.com",
    );
    assertStringIncludes(
      html,
      '<meta property="og:image" content="https://example.com/image/photo.jpg">',
    );
  });

  test("excludes image when empty", () => {
    const html = buildOgTags(
      {
        description: "",
        image_url: "",
        name: "My Listing",
        slug: "my-listing",
      },
      "https://example.com",
    );
    assert(
      !html.includes("og:image"),
      "the value should not contain the searched item",
    );
  });

  test("escapes HTML in listing name", () => {
    const html = buildOgTags(
      {
        description: "",
        image_url: "",
        name: 'Listing "with quotes"',
        slug: "my-listing",
      },
      "https://example.com",
    );
    assertStringIncludes(html, "Listing &quot;with quotes&quot;");
    assert(
      !html.includes('content="Listing "with quotes""'),
      "the value should not contain the searched item",
    );
  });
});
