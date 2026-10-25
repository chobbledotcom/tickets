import { assertExists, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initEmbed } from "#src/ui/client/embed.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller();

describe("embed loader", () => {
  afterEach(async () => {
    await cleanup();
  });

  /** Mount an embed-loader script tag with the given attributes and run the
   *  loader over it; returns the inserted iframe. */
  const runLoader = (
    listings: string,
    title: string | null = null,
  ): HTMLIFrameElement => {
    const script = document.createElement("script");
    script.src = "https://tickets.test/embed.js";
    script.dataset.listings = listings;
    if (title !== null) script.dataset.title = title;
    document.body.append(script);
    initEmbed(script);
    return script.nextElementSibling as HTMLIFrameElement;
  };

  /** Install a resize spy, fire the loader copy's two load events in `order`,
   *  and assert the resize waits for both and names the license once. */
  const runLoads = (
    iframe: HTMLIFrameElement,
    order: "iframe-first" | "script-first",
  ): void => {
    const parentScript = iframe.nextElementSibling as HTMLScriptElement;
    const resizeCalls: [unknown, HTMLIFrameElement][] = [];
    window.iframeResize = ((options: unknown, target: HTMLIFrameElement) => {
      resizeCalls.push([options, target]);
    }) as typeof window.iframeResize;
    const first = order === "iframe-first" ? iframe : parentScript;
    const second = order === "iframe-first" ? parentScript : iframe;
    first.onload?.(new Event("load"));
    expect(resizeCalls).toEqual([]);
    second.onload?.(new Event("load"));
    expect(resizeCalls.length).toBe(1);
    expect(resizeCalls[0]![0]).toEqual({ license: "GPLv3" });
    expect(resizeCalls[0]![1]).toBe(iframe);
  };

  test("inserts a lazy ticket iframe and the resizer parent script", () => {
    installDom("");
    const iframe = runLoader("open,close");
    const parentScript = iframe.nextElementSibling as HTMLScriptElement;

    expect(iframe.src).toBe(
      "https://tickets.test/ticket/open+close?iframe=true",
    );
    expect(iframe.loading).toBe("lazy");
    expect(iframe.getAttribute("title")).toBe("Tickets");
    const style = iframe.getAttribute("style");
    assertExists(style);
    assertStringIncludes(style, "border: none");
    expect(iframe.style.width).toBe("100%");

    expect(parentScript.src).toBe(
      "https://tickets.test/iframe-resizer-parent.js",
    );
    expect(parentScript.async).toBe(true);
    expect(parentScript.fetchPriority).toBe("high");

    // The resize fires only after both load events, and once — driven in the
    // iframe-first order here, and mirrored below.
    runLoads(iframe, "iframe-first");
  });

  test("keeps an explicitly empty title instead of the default", () => {
    installDom("");
    const iframe = runLoader("open", "");

    expect(iframe.getAttribute("title")).toBe("");
  });

  test("resizes in the other load order too", () => {
    installDom("");
    const iframe = runLoader("close");

    runLoads(iframe, "script-first");
  });
});
