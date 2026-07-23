import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { loadBundleWhen } from "#src/ui/client/admin/bundle-loader.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller();

describe("loadBundleWhen", () => {
  afterEach(cleanup);

  test("loads nothing when the page has no matching element", () => {
    const window = installDom("<div></div>");

    loadBundleWhen("[data-widget]", "/widget.js", "/widget.css");

    expect(window.document.head.querySelector("script")).toBeNull();
    expect(window.document.head.querySelector("link")).toBeNull();
  });

  test("loads a script without a stylesheet", () => {
    const window = installDom("<div data-widget></div>");

    loadBundleWhen("[data-widget]", "/widget.js");

    const script = window.document.head.querySelector("script");
    expect(script?.getAttribute("src")).toBe("/widget.js");
    expect(script?.hasAttribute("defer")).toBe(true);
    expect(window.document.head.querySelector("link")).toBeNull();
  });

  test("reuses the local admin bundle cache suffix", () => {
    const window = installDom(
      '<script src="/admin.js?ts=1234"></script><div data-widget></div>',
    );

    loadBundleWhen("[data-widget]", "/widget.js", "/widget.css");

    expect(
      window.document.head.querySelector("script[defer]")?.getAttribute("src"),
    ).toBe("/widget.js?ts=1234");
    expect(
      window.document.head.querySelector("link")?.getAttribute("href"),
    ).toBe("/widget.css?ts=1234");
  });

  test("loads resources beside an absolute CDN admin bundle", () => {
    const window = installDom(
      '<script src="/unrelated.js"></script><script src="https://assets.example.com/assets/release/admin.js?ts=1234"></script><div data-widget></div>',
    );

    loadBundleWhen("[data-widget]", "/widget.js", "/widget.css");

    expect(
      window.document.head.querySelector("script[defer]")?.getAttribute("src"),
    ).toBe("https://assets.example.com/assets/release/widget.js?ts=1234");
    const link = window.document.head.querySelector("link");
    expect(link?.getAttribute("href")).toBe(
      "https://assets.example.com/assets/release/widget.css?ts=1234",
    );
    expect(link?.getAttribute("rel")).toBe("stylesheet");
  });
});
