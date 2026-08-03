import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initDesktopWindowLinks } from "#src/ui/client/admin/desktop-window-links.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const dom = createDomInstaller(["MouseEvent"]);

describe("desktop window links", () => {
  afterEach(dom.cleanup);

  test("opens a new-window link through the desktop binding", () => {
    const window = dom.installDom(
      '<a href="/admin/help" target="_blank"><span>Help</span></a>',
    );
    const opened: string[] = [];
    initDesktopWindowLinks({
      openWindow: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });
    const event = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });

    window.document.querySelector("span")?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual(["https://admin.test/admin/help"]);
  });

  test("leaves ordinary links to the webview", () => {
    const window = dom.installDom('<a href="/admin">Admin</a>');
    const opened: string[] = [];
    initDesktopWindowLinks({
      openWindow: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });
    const event = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });

    window.document.querySelector("a")?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(opened).toEqual([]);
  });

  test("respects a link handler that already opened the target", () => {
    const window = dom.installDom('<a href="/pay" target="_blank">Pay</a>');
    const opened: string[] = [];
    initDesktopWindowLinks({
      openWindow: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });
    const link = window.document.querySelector("a");
    link?.addEventListener("click", (event) => event.preventDefault());
    const event = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });

    link?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual([]);
  });
});
