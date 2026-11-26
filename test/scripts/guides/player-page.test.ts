import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { playerPage } from "#scripts/guides/player-page.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

describe("guide render page", () => {
  test("carries the canvas, the cursor overlay, and the renderer script", () => {
    const html = playerPage({
      guideTitle: "Create a listing",
      scriptSrc: "/renderer.js",
    });

    expectIncludesAll(html, [
      "<title>Create a listing</title>",
      'src="/renderer.js"',
      '<canvas id="stage">',
      '<div id="cursor"><span></span></div>',
      "#stage { display: block; height: auto; width: 100%; }",
      "background: #000;",
    ]);
  });

  test("escapes the guide title and script address", () => {
    const html = playerPage({
      guideTitle: "<Pottery & Co>",
      scriptSrc: '/a"b.js',
    });

    expect(html).toContain("<title>&lt;Pottery &amp; Co&gt;</title>");
    expect(html).toContain('src="/a&quot;b.js"');
    assertStringIncludes(html, "<!doctype html>");
  });
});
