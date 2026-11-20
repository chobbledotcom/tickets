import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  renderSitePage,
  renderSitePages,
  siteHref,
} from "#scripts/model-guides/site.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

const REPOSITORY = "https://github.com/chobbledotcom/tickets";

describe("siteHref", () => {
  test("sends repository paths to GitHub and page links to HTML", () => {
    expect(
      [
        "../../verification/Sample.tla#L4",
        "../../src/fake.ts#L2",
        "../model-verification.md",
        "Sample.md",
        "README.md",
      ].map(siteHref),
    ).toEqual([
      `${REPOSITORY}/blob/main/verification/Sample.tla#L4`,
      `${REPOSITORY}/blob/main/src/fake.ts#L2`,
      `${REPOSITORY}/blob/main/docs/model-verification.md`,
      "Sample.html",
      "index.html",
    ]);
  });

  test("leaves external links, anchors, and plain paths alone", () => {
    expect(
      [
        "https://example.com/guide.md",
        "mailto:help@example.com",
        "#cast",
        "images/example.png",
      ].map(siteHref),
    ).toEqual([
      "https://example.com/guide.md",
      "mailto:help@example.com",
      "#cast",
      "images/example.png",
    ]);
  });
});

describe("renderSitePage", () => {
  test("renders the title, navigation, body, and rewritten links", () => {
    const page = renderSitePage(
      [
        "# A sample walkthrough",
        "",
        "[Next](Next.md) and [the source](../../src/fake.ts#L2).",
      ].join("\n"),
    );
    expectIncludesAll(page, [
      "<title>A sample walkthrough · Chobble Tickets</title>",
      '<a href="./index.html">All models</a>',
      '<a href="../doc.ts/index.html">API reference</a>',
      "<h1>A sample walkthrough</h1>",
      '<a href="Next.html">Next</a>',
      `<a href="${REPOSITORY}/blob/main/src/fake.ts#L2">the source</a>`,
    ]);
  });

  test("uses a fallback title and escapes the heading", () => {
    expect(renderSitePage("No heading here.")).toContain(
      "<title>Model walkthroughs · Chobble Tickets</title>",
    );
    expect(renderSitePage("# <Sample>")).toContain(
      "<title>&lt;Sample&gt; · Chobble Tickets</title>",
    );
  });

  test("keeps links inside code spans and blocks as written", () => {
    const page = renderSitePage(
      [
        "# A sample walkthrough",
        "",
        "`[inline](README.md)`",
        "",
        "```",
        "[block](README.md)",
        "```",
      ].join("\n"),
    );
    expectIncludesAll(page, [
      "<code>[inline](README.md)</code>",
      "[block](README.md)",
    ]);
  });
});

describe("renderSitePages", () => {
  test("names the index and each guide as an HTML page", () => {
    const pages = renderSitePages(
      new Map([
        ["Sample.md", "# Sample walkthrough"],
        ["README.md", "# Model walkthroughs"],
      ]),
    );
    expect([...pages.keys()]).toEqual(["Sample.html", "index.html"]);
    expectIncludesAll(pages.get("Sample.html")!, [
      "<h1>Sample walkthrough</h1>",
    ]);
  });
});
