import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller();

afterEach(async () => {
  await cleanup();
});

/** Mount the embed loader's script tag and override `currentScript`, then run
 *  one fresh copy of the module. The loader is an import-time IIFE, so each
 *  scenario needs its own module instance — a static import would run it once
 *  per isolate and no test could observe a second run. A null title leaves the
 *  attribute off; an empty string sets it to nothing. */
const runLoader = async (
  caseKey: string,
  listings: string,
  title: string | null = null,
): Promise<HTMLIFrameElement> => {
  const script = document.createElement("script");
  script.src = "https://tickets.test/embed.js";
  script.dataset.listings = listings;
  if (title !== null) script.dataset.title = title;
  document.body.append(script);
  Object.defineProperty(document, "currentScript", {
    configurable: true,
    get: () => script,
  });
  await import(`#src/ui/client/embed.ts?case=${caseKey}`);
  return script.nextElementSibling as HTMLIFrameElement;
};

describe("embed loader", () => {
  test("inserts a lazy ticket iframe and the resizer parent script", async () => {
    installDom("");
    const iframe = await runLoader("markup", "open,close", "Book a ticket");

    expect(iframe.src).toBe(
      "https://tickets.test/ticket/open+close?iframe=true",
    );
    expect(iframe.loading).toBe("lazy");
    expect(iframe.getAttribute("title")).toBe("Book a ticket");
    expect(iframe.getAttribute("style")).toContain("border: none");
    expect(iframe.style.width).toBe("100%");

    const parentScript = iframe.nextElementSibling as HTMLScriptElement;
    expect(parentScript.src).toBe(
      "https://tickets.test/iframe-resizer-parent.js",
    );
    expect(parentScript.async).toBe(true);
    expect(parentScript.fetchPriority).toBe("high");
  });

  test("titles the iframe Tickets when no title is given", async () => {
    installDom("");
    const iframe = await runLoader("default-title", "open");

    expect(iframe.getAttribute("title")).toBe("Tickets");
  });

  test("keeps an explicitly empty title instead of the default", async () => {
    installDom("");
    const iframe = await runLoader("empty-title", "open", "");

    expect(iframe.getAttribute("title")).toBe("");
  });

  test("resizes only once both the iframe and the parent script loaded", async () => {
    installDom("");
    const iframe = await runLoader("iframe-first", "open");
    const parentScript = iframe.nextElementSibling as HTMLScriptElement;
    const resizeCalls: [Record<string, unknown>, HTMLIFrameElement][] = [];
    window.iframeResize = ((
      options: Record<string, unknown>,
      target: HTMLIFrameElement,
    ) => {
      resizeCalls.push([options, target]);
    }) as typeof window.iframeResize;

    iframe.onload?.(new Event("load"));
    expect(resizeCalls).toEqual([]);

    parentScript.onload?.(new Event("load"));
    expect(resizeCalls.length).toBe(1);
    expect(resizeCalls[0]![0]).toEqual({ license: "GPLv3" });
    expect(resizeCalls[0]![1]).toBe(iframe);
  });

  test("resizes in the other load order too", async () => {
    installDom("");
    const iframe = await runLoader("script-first", "close");
    const parentScript = iframe.nextElementSibling as HTMLScriptElement;
    const resizeCalls: [Record<string, unknown>, HTMLIFrameElement][] = [];
    window.iframeResize = ((
      options: Record<string, unknown>,
      target: HTMLIFrameElement,
    ) => {
      resizeCalls.push([options, target]);
    }) as typeof window.iframeResize;

    parentScript.onload?.(new Event("load"));
    expect(resizeCalls).toEqual([]);

    iframe.onload?.(new Event("load"));
    expect(resizeCalls.length).toBe(1);
    expect(resizeCalls[0]![0]).toEqual({ license: "GPLv3" });
    expect(resizeCalls[0]![1]).toBe(iframe);
  });
});
