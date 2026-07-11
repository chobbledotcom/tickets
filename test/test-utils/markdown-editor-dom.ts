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
import {
  enhanceMarkdownTextarea,
  type MarkdownEditorHandle,
} from "#src/ui/client/admin/markdown-editor.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

export const { installDom, cleanup } = createDomInstaller([
  "navigator",
  "getComputedStyle",
  "MutationObserver",
  "Event",
]);

const TEXTAREA = "<textarea data-markdown-preview>%s</textarea>";
const FOOTER =
  '<div class="md-editor-footer"><button type="button">Preview</button></div>';

/** Install a lone markdown textarea (optionally followed by a footer strip,
 * as the preview module lays out) and enhance it. */
export const enhanced = (
  value: string,
  options: { footer?: boolean } = {},
): {
  handle: MarkdownEditorHandle;
  textarea: HTMLTextAreaElement;
  window: Window;
} => {
  const window = installDom(
    TEXTAREA.replace("%s", value) + (options.footer ? FOOTER : ""),
  );
  const textarea = window.document.querySelector(
    "textarea",
  ) as unknown as HTMLTextAreaElement;
  return { handle: enhanceMarkdownTextarea(textarea), textarea, window };
};

/** Move the editor selection (a caret when `to` is omitted). */
export const select = (view: EditorView, from: number, to = from): void => {
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
  );
};

/** The toolbar button carrying the `md-toolbar-<key>` modifier class. */
export const toolbarButton = (
  window: Window,
  key: string,
): HTMLButtonElement & { click: () => void } =>
  window.document.querySelector(
    `.md-toolbar-${key}`,
  ) as unknown as HTMLButtonElement & { click: () => void };

export const isActive = (button: HTMLButtonElement): boolean =>
  button.classList.contains("md-toolbar-button-active");

/** Override the window's `prompt` (not typed on happy-dom's Window). */
export const setPrompt = (
  window: Window,
  fn: (message?: string) => string | null,
): void => {
  (window as unknown as { prompt: typeof fn }).prompt = fn;
};

/** Assert the contenteditable surface, not a toolbar button, holds focus. */
export const expectEditorFocused = (window: Window): void => {
  expect(window.document.activeElement).toBe(
    window.document.querySelector(".md-editor .ProseMirror"),
  );
};
