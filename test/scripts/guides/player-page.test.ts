import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { playerPage } from "#scripts/guides/player-page.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

describe("guide player page", () => {
  test("builds a responsive, autoplaying iframe page", () => {
    const html = playerPage({
      autoplay: true,
      guideTitle: "Create a listing",
      scriptSrc: "../player.js",
    });

    expectIncludesAll(html, [
      "<title>Create a listing</title>",
      "globalThis.__GUIDE_AUTOPLAY__ = true;",
      'src="../player.js"',
      '<canvas id="stage">',
      "#stage { display: block; height: auto; width: 100%; }",
      "background: transparent;",
    ]);
  });

  test("leaves autoplay out for the local render", () => {
    const html = playerPage({
      autoplay: false,
      guideTitle: "Create a listing",
      scriptSrc: "/renderer.js",
    });

    assert(!html.includes("__GUIDE_AUTOPLAY__"));
    assertStringIncludes(html, 'src="/renderer.js"');
    assertStringIncludes(html, "background: #000;");
  });

  test("escapes the guide title and script address", () => {
    const html = playerPage({
      autoplay: false,
      guideTitle: "<Pottery & Co>",
      scriptSrc: '/a"b.js',
    });

    expect(html).toContain("<title>&lt;Pottery &amp; Co&gt;</title>");
    expect(html).toContain('src="/a&quot;b.js"');
  });
});
