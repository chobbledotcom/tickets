import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller();

describe("iframe resizer parent", () => {
  afterEach(async () => {
    await cleanup();
  });

  // The parent bundle is an import-time assignment, so the module must load
  // after the DOM installer put a window in place; a static import would run
  // before any window exists.
  test("exposes iframeResize on the window for the embed loader", async () => {
    installDom("");

    await import("#src/ui/client/iframe-resizer-parent.ts");

    expect(typeof window.iframeResize).toBe("function");
  });
});
