/**
 * Behavioural test for the markdown editor bundle entry
 * (`src/ui/client/markdown-editor.ts`, served as `/markdown-editor.js`): it
 * mounts the rich editor on every textarea the admin templates mark with
 * `data-markdown-preview`, and on nothing else.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { requireElement } from "#test-utils/happy-dom.ts";
import { cleanup, installDom } from "#test-utils/markdown-editor-dom.ts";

afterEach(cleanup);

describe("markdown editor bundle bootstrap", () => {
  test("mounts the rich editor on the marked textarea alone", async () => {
    const window = installDom(
      "<textarea data-markdown-preview># Title</textarea>" +
        "<textarea># Plain</textarea>",
    );
    const [marked, plain] = window.document.querySelectorAll("textarea");

    // The import IS the boot: it mounts on load, so a static import would run
    // before this test installs the DOM it reads.
    await import("#src/ui/client/markdown-editor.ts");

    const mount = requireElement<HTMLElement>(window.document, ".md-editor");
    expect(requireElement(mount, ".ProseMirror").textContent).toBe("Title");
    expect(marked!.classList.contains("md-editor-hidden")).toBe(true);
    expect(marked!.value).toBe("# Title");
    expect(plain!.classList.contains("md-editor-hidden")).toBe(false);
    expect(plain!.value).toBe("# Plain");
    expect(window.document.querySelectorAll(".ProseMirror")).toHaveLength(1);
  });
});
