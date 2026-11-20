/**
 * The markdown preview (`src/ui/client/admin/markdown-preview.ts`): the link
 * under each markdown field, the request it makes, and the window it fills.
 * The window itself is the shared admin modal shell, covered in
 * `modal.test.ts`; this file covers what the preview puts in it.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
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

/** Open the first preview and let the test settle each request itself. */
const pendingPreviews = (fields = FIELD) => {
  const first = Promise.withResolvers<Response>();
  const second = Promise.withResolvers<Response>();
  const fetch = stubFetch(
    () => first.promise,
    () => second.promise,
  );
  const window = page(fields);
  linksIn(window)[0]!.click();
  return {
    first,
    second,
    window,
    [Symbol.dispose]: () => fetch.restore(),
  };
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

describe("the markdown preview", () => {
  afterEach(async () => {
    closeDialogs(document, "dialog.admin-modal");
    await cleanup();
  });

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

  for (const name of ["open", "title", "empty", "failed", "loading"]) {
    test(`rejects a template without its ${name} copy before any request`, () => {
      const window = installDom(`${TEMPLATES}${FIELD}`);
      const template = requireElement<HTMLTemplateElement>(
        window.document,
        "template#markdown-preview",
      );
      requireElement(template.content, `[data-copy="${name}"]`).remove();

      expect(() => initMarkdownPreview()).toThrow(
        `Missing element: [data-copy="${name}"]`,
      );
    });
  }

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
    ).toBe("markdown-preview:0");
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

  for (const [name, body] of [
    [
      "matching names in separate forms",
      `<form>${FIELD}</form><form>${FIELD}</form>`,
    ],
    [
      "an id that matches another name",
      `<textarea data-markdown-preview id="content">One</textarea>${FIELD}`,
    ],
    ["unnamed fields", "<textarea data-markdown-preview></textarea>".repeat(2)],
    [
      "a name that resembles a generated key",
      FIELD +
        FIELD +
        '<textarea data-markdown-preview name="content:1">Three</textarea>',
    ],
  ] as const) {
    test(`keeps separate windows for ${name}`, async () => {
      using _fetch = stubFetch((_url, init) => {
        const text = new URLSearchParams(String(init?.body)).get("content");
        return new Response(`<p>${text}</p>`);
      });
      const window = page(body);
      const fields = requireElements<HTMLTextAreaElement>(
        window.document,
        "textarea",
      );

      for (const [index, field] of fields.entries()) {
        field.value = `Answer ${index}`;
        await preview(window, index);
      }

      const dialogs = requireElements<HTMLDialogElement>(
        window.document,
        MODAL,
      );
      expect(dialogs).toHaveLength(fields.length);
      expect(
        new Set(dialogs.map((dialog) => dialog.dataset.modalKey)).size,
      ).toBe(fields.length);
      expect(
        dialogs.map(
          (dialog) => requireElement(dialog, ".md-preview-content").textContent,
        ),
      ).toEqual(fields.map((_field, index) => `Answer ${index}`));
    });
  }

  for (const [name, stale] of [
    ["text", new Response("<p>Old answer</p>")],
    ["empty text", new Response("")],
    ["a refused request", new Response("no", { status: 500 })],
    ["a network failure", new Error("offline")],
  ] as const) {
    test(`ignores an older request with ${name} that settles last`, async () => {
      using pending = pendingPreviews();
      pending.second.resolve(new Response("<p>Latest answer</p>"));
      await preview(pending.window);

      if (stale instanceof Error) pending.first.reject(stale);
      else pending.first.resolve(stale);
      await flush();

      expect(contentIn(pending.window).innerHTML).toBe("<p>Latest answer</p>");
    });
  }

  test("ignores an older response whose body arrives last", async () => {
    const body = Promise.withResolvers<string>();
    const first = new Response();
    using _body = stub(first, "text", () => body.promise);
    using pending = pendingPreviews();
    pending.first.resolve(first);
    await flush();
    pending.second.resolve(new Response("<p>Latest answer</p>"));
    await preview(pending.window);

    body.resolve("<p>Old answer</p>");
    await flush();

    expect(contentIn(pending.window).innerHTML).toBe("<p>Latest answer</p>");
  });

  test("keeps the latest preview after a close and reopen", async () => {
    using pending = pendingPreviews();
    requireElement<HTMLDialogElement>(pending.window.document, MODAL).close();
    pending.second.resolve(new Response("<p>Reopened answer</p>"));
    await preview(pending.window);

    pending.first.resolve(new Response("<p>Closed answer</p>"));
    await flush();

    expect(contentIn(pending.window).innerHTML).toBe("<p>Reopened answer</p>");
  });

  test("says when the response body cannot load", async () => {
    const response = new Response();
    using _body = stub(response, "text", () =>
      Promise.reject(new Error("stream interrupted")),
    );

    expect(await wordsAfter(response)).toBe("Preview failed.");
  });

  test("keeps the loading note when an older request finishes first", async () => {
    using pending = pendingPreviews();
    await preview(pending.window);

    pending.first.resolve(new Response("<p>Old answer</p>"));
    await flush();
    expect(contentIn(pending.window).textContent).toBe("Loading preview…");

    pending.second.resolve(new Response("<p>Latest answer</p>"));
    await flush();
    expect(contentIn(pending.window).innerHTML).toBe("<p>Latest answer</p>");
  });

  test("lets different fields finish in either order", async () => {
    using pending = pendingPreviews(FIELD + FIELD);
    linksIn(pending.window)[1]!.click();

    pending.second.resolve(new Response("<p>Second field</p>"));
    pending.first.resolve(new Response("<p>First field</p>"));
    await flush();

    expect(
      requireElements(pending.window.document, ".md-preview-content").map(
        (content) => content.textContent,
      ),
    ).toEqual(["First field", "Second field"]);
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
    ).toEqual(["markdown-preview:0", "markdown-preview:1"]);
  });
});
