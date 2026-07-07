import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildOgTags,
  migrationInProgressPage,
  notFoundPage,
  siteNotActivatedPage,
  temporaryErrorPage,
} from "#templates/public.tsx";

import { registerPublicTemplateHooks } from "./helpers.ts";

registerPublicTemplateHooks();

describe("buildOgTags", () => {
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

describe("notFoundPage", () => {
  test("renders not found message", () => {
    const html = notFoundPage();
    expect(html).toContain("<h1>Not Found</h1>");
  });
});

describe("temporaryErrorPage", () => {
  test("renders error message with auto-refresh", () => {
    const html = temporaryErrorPage();
    expect(html).toContain("<h1>Temporary Error</h1>");
    expect(html).toContain("Retrying automatically");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('content="2"');
    expect(html).toContain("<style>");
    expect(html).toContain("font-family:system-ui");
  });
});

describe("migrationInProgressPage", () => {
  test("renders update message with auto-refresh", () => {
    const html = migrationInProgressPage();
    expect(html).toContain("<h1>Update In Progress</h1>");
    expect(html).toContain("backing up and updating the database");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('content="5"');
    expect(html).toContain("<style>");
    expect(html).toContain("font-family:system-ui");
  });

  test("does not present itself as an error", () => {
    const html = migrationInProgressPage();
    expect(html).not.toContain("Error");
  });
});

describe("siteNotActivatedPage", () => {
  test("renders not-activated message in the error dialog style", () => {
    const html = siteNotActivatedPage();
    expect(html).toContain(
      '<div class="prose"><h1>Not Activated</h1><p>This site has not been activated yet.</p></div>',
    );
    expect(html).toContain("<style>");
    expect(html).toContain("font-family:system-ui");
  });

  test("does not auto-refresh", () => {
    const html = siteNotActivatedPage();
    expect(html).not.toContain('http-equiv="refresh"');
  });
});
