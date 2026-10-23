import type { iframeResizer } from "@iframe-resizer/child";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initIframeScrollIntoView } from "#src/ui/client/admin/iframe-scroll-into-view.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller();

afterEach(async () => {
  delete window.parentIframe;
  await cleanup();
});

/** Install the parent handle the child bundle creates, recording scrolls. */
const installParentIframe = (): [number, number][] => {
  const calls: [number, number][] = [];
  window.parentIframe = {
    scrollToOffset: (x: number, y: number) => {
      calls.push([x, y]);
    },
  } as iframeResizer.IFramePage;
  return calls;
};

describe("iframe scroll into view", () => {
  test("scrolls the parent to the iframe's top-left corner", () => {
    installDom("<div data-scroll-into-view></div>");
    const calls = installParentIframe();

    initIframeScrollIntoView();

    expect(calls).toEqual([[0, 0]]);
  });

  test("does nothing when the page carries no scroll target", () => {
    installDom("<div></div>");
    const calls = installParentIframe();

    initIframeScrollIntoView();

    expect(calls).toEqual([]);
  });

  test("does nothing when the child bundle has not created the handle", () => {
    installDom("<div data-scroll-into-view></div>");

    expect(() => initIframeScrollIntoView()).not.toThrow();
  });
});
