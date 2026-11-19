/**
 * The markdown preview (`src/ui/client/admin/markdown-preview.ts`): the link
 * under each markdown field, the request it makes, and the window it fills.
 * The window itself is the shared admin modal shell, covered in
 * `modal.test.ts`; this file covers what the preview puts in it.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { initMarkdownPreview } from "#src/ui/client/admin/markdown-preview.ts";
import { initAdminModalShell } from "#src/ui/client/admin/modal.ts";
import { MarkdownPreviewTemplate } from "#templates/admin/markdown-preview.tsx";
import { AdminModalTemplate } from "#templates/admin/modal.tsx";
import { type FetchReply, stubFetch } from "#test-utils/fetch-stub.ts";
import {
  closeDialogs,
  createDomInstaller,
  requireElement,
  requireElements,
} from "#test-utils/happy-dom.ts";
import { flush } from "#test-utils/markdown-image-dialog.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

/** The two templates as the server renders them, with the catalog's words. */
const TEMPLATES = await withRequestContext(
  () => `${String(AdminModalTemplate())}${String(MarkdownPreviewTemplate())}`,
);

const { installDom, cleanup } = createDomInstaller(["Element"]);

/** One markdown field, as the server renders it. */
const FIELD = '<textarea data-markdown-preview name="content">Hello</textarea>';

const MODAL = "dialog.admin-modal";

/** Mount a page with the templates and the given body, then start the preview
 *  the way the admin entry point does. */
const page = (body: string): Window => {
  const window = installDom(`${TEMPLATES}${body}`);
  initAdminModalShell();
  initMarkdownPreview();
  return window;
};

const linksIn = (window: Window): HTMLButtonElement[] =>
  requireElements<HTMLButtonElement>(window.document, ".md-preview-link");

const footerIn = (window: Window): HTMLElement =>
  requireElement<HTMLElement>(window.document, ".md-editor-footer");

const contentIn = (window: Window): HTMLElement =>
  requireElement<HTMLElement>(window.document, ".md-preview-content");

/** Click one preview link and let its request settle. */
const preview = async (window: Window, index = 0): Promise<void> => {
  linksIn(window)[index]!.click();
  await flush();
};

/** The words the preview settles on, for the reply that cannot show text.
 *  The window closes again, so the next probe opens its own. */
const wordsAfter = async (reply: FetchReply): Promise<string | null> => {
  using _fetch = stubFetch(reply);
  const window = page(FIELD);
  await preview(window);
  const words = contentIn(window).textContent;
  requireElement<HTMLDialogElement>(window.document, MODAL).close();
  return words;
};

/** The page a request test mounts, with the request bodies it sent. */
type Sent = { bodies: string[]; window: Window };

/** Mount `body`, open its preview, and hand back what it sent. */
const sentFrom = async (body: string): Promise<Sent> => {
  const bodies: string[] = [];
  using _fetch = stubFetch((_url, init) => {
    bodies.push(String(init?.body));
    return new Response("<p>Hello</p>");
  });
  const window = page(body);
  await preview(window);
  return { bodies, window };
};

afterEach(async () => {
  closeDialogs(document, "dialog.admin-modal");
  await cleanup();
});

describe("the markdown preview", () => {
  test("adds a Preview link under each markdown field", () => {
    const window = page(FIELD);
    const link = linksIn(window)[0]!;

    expect(linksIn(window)).toHaveLength(1);
    expect(link.textContent).toBe("Preview");
    expect(link.getAttribute("type")).toBe("button");
    expect(link.closest(".md-editor-footer")).not.toBeNull();
    expect(window.document.querySelector("textarea")!.nextElementSibling).toBe(
      link.closest(".md-editor-footer"),
    );
  });

  test("leaves a page with no markdown field alone", () => {
    // The page does not even carry the templates: the module must not look
    // for them when no field asks for a preview.
    const window = installDom("<p>Nothing to preview here</p>");
    initMarkdownPreview();

    expect(window.document.querySelector(".md-editor-footer")).toBeNull();
  });

  test("moves the character counter into the footer, opposite the link", () => {
    const window = page(
      `<div>${FIELD}<small class="char-counter">5 / 10</small></div>`,
    );
    const footer = footerIn(window);

    expect([...footer.children].map((child) => child.className)).toEqual([
      "md-preview-link",
      "char-counter",
    ]);
    expect(window.document.querySelector(".char-counter")!.parentElement).toBe(
      footer,
    );
  });

  test("leaves a following element that is not a counter where it was", () => {
    const window = page(`<div>${FIELD}<span class="hint">Hint</span></div>`);
    const footer = footerIn(window);

    expect([...footer.children]).toHaveLength(1);
    expect(footer.nextElementSibling).toBe(
      window.document.querySelector(".hint"),
    );
  });

  test("shows the rendered preview in the field's own window", async () => {
    const { bodies, window } = await sentFrom(
      '<form action="/admin/site/home" method="post">' +
        '<input type="hidden" name="csrfToken" value="page-token">' +
        '<textarea data-markdown-preview id="homepageText" name="homepageText">' +
        "Hello world</textarea></form>",
    );

    expect(
      requireElement<HTMLDialogElement>(window.document, "dialog.admin-modal")
        .dataset.modalKey,
    ).toBe("markdown-preview:homepageText");
    expect(
      requireElement<HTMLElement>(window.document, ".admin-modal-title")
        .textContent,
    ).toBe("Markdown preview");
    expect(contentIn(window).innerHTML).toBe("<p>Hello</p>");
    const sent = new URLSearchParams(bodies[0]!);
    expect(sent.get("content")).toBe("Hello world");
    expect(sent.get("csrfToken")).toBe("page-token");
  });

  test("sends no token when the field has no form", async () => {
    const { bodies } = await sentFrom(FIELD);
    expect(new URLSearchParams(bodies[0]!).get("csrfToken")).toBe("");
  });

  test("says in the window why it cannot show the text", async () => {
    expect(await wordsAfter(new Response("   \n "))).toBe(
      "Nothing to preview.",
    );
    expect(await wordsAfter(new Response("no", { status: 500 }))).toBe(
      "Preview failed.",
    );
    expect(await wordsAfter(new Error("offline"))).toBe("Preview failed.");
  });

  test("raises one window per field, and fills it with the latest preview", async () => {
    using _fetch = stubFetch(
      new Response("<p>First answer</p>"),
      new Response("<p>Second answer</p>"),
    );
    const window = page(FIELD);

    await preview(window);
    await preview(window);

    expect(window.document.querySelectorAll("dialog.admin-modal")).toHaveLength(
      1,
    );
    expect(contentIn(window).innerHTML).toBe("<p>Second answer</p>");
  });

  test("opens a separate window for each field", async () => {
    using _fetch = stubFetch(new Response("<p>Answer</p>"));
    const window = page(
      '<textarea data-markdown-preview name="description">One</textarea>' +
        '<textarea data-markdown-preview name="termsAndConditions">Two</textarea>',
    );

    await preview(window, 0);
    await preview(window, 1);

    expect(
      requireElements<HTMLDialogElement>(
        window.document,
        "dialog.admin-modal",
      ).map((dialog) => dialog.dataset.modalKey),
    ).toEqual([
      "markdown-preview:description",
      "markdown-preview:termsAndConditions",
    ]);
  });
});
