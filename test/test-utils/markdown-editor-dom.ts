/**
 * Shared happy-dom harness for the markdown editor suites: installs the
 * window globals ProseMirror needs, mounts the rich editor over a lone
 * markdown textarea, and exposes the toolbar/selection helpers used by the
 * editor, setup, and toolbar test files.
 */

import { expect } from "@std/expect";
import type { Window } from "happy-dom";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { withRequestStore } from "#shared/request-context.ts";
import {
  enhanceMarkdownTextarea,
  type MarkdownEditorHandle,
} from "#src/ui/client/admin/markdown-editor.ts";
import { ImagePickerTemplate } from "#templates/admin/image-picker.tsx";
import { AdminModalTemplate } from "#templates/admin/modal.tsx";
import { createDomInstaller, requireElement } from "#test-utils/happy-dom.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

export const { installDom, cleanup } = createDomInstaller([
  "navigator",
  "getComputedStyle",
  "MutationObserver",
  "Event",
]);

const TEXTAREA = "<textarea data-markdown-preview>%s</textarea>";
const FOOTER =
  '<div class="md-editor-footer"><button type="button">Preview</button></div>';

/** The CSRF token that the picker's own upload form carries. */
export const PICKER_CSRF_TOKEN = "picker-token";

/** The picker that an admin page with image storage carries, rendered by the
 * real server template under a request with a known CSRF token. */
const PICKER_TEMPLATE = await withRequestContext(() => {
  withRequestStore((store) => {
    store.csrfToken = PICKER_CSRF_TOKEN;
  });
  return String(ImagePickerTemplate());
});

/** The window markup that every admin page carries, rendered by the real
 * server template. */
const MODAL_TEMPLATE = await withRequestContext(() =>
  String(AdminModalTemplate()),
);

/** The two templates of an admin page with image storage: the window shell
 * and the picker that the shell shows. */
export const ADMIN_TEMPLATES = MODAL_TEMPLATE + PICKER_TEMPLATE;

/** Install a lone markdown textarea and enhance it. The page carries the
 * window shell, and the image picker template unless `imageStorage` is false.
 * Options add a footer strip as the preview module lays out, a stylesheet that
 * the editor's styles are asserted against, or a page form around the textarea
 * with a token of its own. */
export const enhanced = (
  value: string,
  options: {
    footer?: boolean;
    stylesheet?: string;
    form?: boolean;
    imageStorage?: false;
  } = {},
): {
  handle: MarkdownEditorHandle;
  textarea: HTMLTextAreaElement;
  window: Window;
} => {
  const textareaHtml = TEXTAREA.replace("%s", value);
  const window = installDom(
    (options.stylesheet ? `<style>${options.stylesheet}</style>` : "") +
      (options.imageStorage === false ? MODAL_TEMPLATE : ADMIN_TEMPLATES) +
      (options.form
        ? `<form action="/admin/pages/1/edit" method="post">` +
          `<input type="hidden" name="csrfToken" value="page-token">${textareaHtml}</form>`
        : textareaHtml) +
      (options.footer ? FOOTER : ""),
  );
  const textarea = requireElement<HTMLTextAreaElement>(
    window.document,
    "textarea",
  );
  return { handle: enhanceMarkdownTextarea(textarea), textarea, window };
};

/** Move the editor selection (a caret when `to` is omitted). */
export const select = (view: EditorView, from: number, to = from): void => {
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
  );
};

/** The toolbar button carrying the `md-toolbar-<key>` modifier class. */
export const toolbarButton = (window: Window, key: string): HTMLButtonElement =>
  requireElement<HTMLButtonElement>(window.document, `.md-toolbar-${key}`);

export const isActive = (button: HTMLButtonElement): boolean =>
  button.classList.contains("md-toolbar-button-active");

/** Override the window's `prompt` (not typed on happy-dom's Window). */
export const setPrompt = (
  window: Window,
  fn: (message?: string) => string | null,
): void => {
  Object.assign(window, { prompt: fn });
};

/** Assert the contenteditable surface, not a toolbar button, holds focus. */
export const expectEditorFocused = (window: Window): void => {
  expect(window.document.activeElement).toBe(
    window.document.querySelector(".md-editor .ProseMirror"),
  );
};
