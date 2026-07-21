import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { buildOgTags } from "#templates/public/reservations/og-tags.ts";

import { registerPublicTemplateHooks } from "#test/templates/public/helpers.ts";
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
    expect(html).toContain('<meta property="og:title" content="My Listing">');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain(
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
    expect(html).toContain(
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
    expect(html).not.toContain("og:description");
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
    expect(html).toContain(
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
    expect(html).not.toContain("og:image");
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
    expect(html).toContain("Listing &quot;with quotes&quot;");
    expect(html).not.toContain('content="Listing "with quotes""');
  });
});
