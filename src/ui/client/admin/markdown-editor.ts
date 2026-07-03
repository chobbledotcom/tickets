/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Rich markdown editor: progressively enhances every markdown-authored
 * textarea (marked `data-markdown-preview`, like the preview dialog) with a
 * ProseMirror editor.
 *
 * The textarea remains the real form control — every rich edit is serialized
 * back to markdown into it and re-announced as an `input` event — so form
 * submission, server-side validation, the character counter and the preview
 * dialog all keep working unchanged. A footer button toggles to the raw
 * textarea for anything the visual editor doesn't model (e.g. tables), and a
 * blocked required-field submit reveals the textarea so the browser's
 * validation UI has a focusable control to point at.
 */

import { EditorView } from "prosemirror-view";
import {
  createEditorState,
  serializeMarkdown,
} from "./markdown-editor-setup.ts";

/** Applied to whichever of the textarea / rich editor is inactive. */
const HIDDEN_CLASS = "md-editor-hidden";

type EditorMode = "rich" | "raw";

/** Toggle-button label naming the mode a click switches to. */
const TOGGLE_LABELS: Record<EditorMode, string> = {
  raw: "Edit visually",
  rich: "Edit markdown",
};

export interface MarkdownEditorHandle {
  setMode: (mode: EditorMode) => void;
  view: EditorView;
}

/** Mount a rich editor over one markdown textarea. */
export const enhanceMarkdownTextarea = (
  textarea: HTMLTextAreaElement,
): MarkdownEditorHandle => {
  const mount = document.createElement("div");
  mount.className = "md-editor";
  textarea.insertAdjacentElement("afterend", mount);

  const view: EditorView = new EditorView(mount, {
    dispatchTransaction: (tr) => {
      view.updateState(view.state.apply(tr));
      if (!tr.docChanged) return;
      // Keep the textarea current on every doc change (not just on submit) so
      // everything reading it — char counter, preview, unload warnings — sees
      // live content. The input event is what the char counter listens for.
      textarea.value = serializeMarkdown(view.state.doc);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    },
    state: createEditorState(textarea.value),
  });

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "md-preview-link md-editor-toggle";

  let mode: EditorMode = "rich";
  const setMode = (next: EditorMode): void => {
    mode = next;
    const raw = next === "raw";
    textarea.classList.toggle(HIDDEN_CLASS, !raw);
    mount.classList.toggle(HIDDEN_CLASS, raw);
    toggle.textContent = TOGGLE_LABELS[next];
    // Raw-mode edits happen directly in the textarea, so entering rich mode
    // rebuilds the document from the textarea's current markdown.
    if (!raw) view.updateState(createEditorState(textarea.value));
  };
  setMode(mode);

  toggle.addEventListener("click", () =>
    setMode(mode === "rich" ? "raw" : "rich"),
  );
  // A required-but-empty textarea blocks submit while hidden, where the
  // browser can't focus it to show why — reveal it when that happens.
  textarea.addEventListener("invalid", () => setMode("raw"));

  // With the mount inserted directly after the textarea, the next sibling is
  // the footer strip whenever the preview module has laid one out — put the
  // toggle in there beside the preview link, else directly after the editor.
  const next = mount.nextElementSibling;
  if (next?.classList.contains("md-editor-footer")) {
    next.prepend(toggle);
  } else {
    mount.insertAdjacentElement("afterend", toggle);
  }

  return { setMode, view };
};

/** Enhance every markdown-authored textarea on the page. */
export const initMarkdownEditor = (): void => {
  for (const textarea of document.querySelectorAll<HTMLTextAreaElement>(
    "textarea[data-markdown-preview]",
  )) {
    enhanceMarkdownTextarea(textarea);
  }
};
