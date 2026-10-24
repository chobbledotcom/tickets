import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller();

describe("embed bundle bootstrap", () => {
  afterEach(async () => {
    await cleanup();
  });

  test("boots the loader for the script tag that shipped it", async () => {
    installDom("");
    const script = document.createElement("script");
    script.src = "https://tickets.test/embed.js";
    script.dataset.listings = "open";
    document.body.append(script);
    Object.defineProperty(document, "currentScript", {
      configurable: true,
      get: () => script,
    });

    await import("#src/ui/client/embed-main.ts");

    const iframe = script.nextElementSibling as HTMLIFrameElement;
    expect(iframe?.src).toBe("https://tickets.test/ticket/open?iframe=true");
  });
});
