/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Rich markdown editor: progressively enhances every markdown-authored
 * textarea. The textarea stays the real form control, and every rich edit is
 * serialized back into it and re-announced as an `input` event, so submission,
 * validation, the character counter, and the preview dialog keep working.
 *
 * A field whose stored markdown does not survive the round trip opens in raw
 * mode, so rich editing never silently rewrites it. A blocked required-field
 * submit reveals the textarea, because the browser's validation UI needs a
 * focusable control to point at.
 */

import { EditorView } from "prosemirror-view";
import {
  createEditorState,
  roundTripsCleanly,
  serializeMarkdown,
} from "./markdown-editor-setup.ts";
import { createToolbar } from "./markdown-editor-toolbar.ts";

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
  textarea.after(mount);

  // The field's markdown maxlength (−1 when unset). Rich-mode typing edits the
  // ProseMirror document, not the textarea, so the browser's own maxlength no
  // longer bites — this replicates it against the serialized markdown, which
  // is exactly what the server validates.
  const maxLength = textarea.maxLength;

  const view: EditorView = new EditorView(mount, {
    dispatchTransaction: (tr) => {
      const nextMarkdown = tr.docChanged ? serializeMarkdown(tr.doc) : null;
      // Reject an edit that would push the stored markdown past the limit, but
      // only when it grows the text — deletions that stay over are still
      // allowed, so an over-long field can always be trimmed back down.
      if (
        nextMarkdown !== null &&
        maxLength > 0 &&
        nextMarkdown.length > maxLength &&
        nextMarkdown.length > textarea.value.length
      ) {
        return;
      }
      view.updateState(view.state.apply(tr));
      toolbar.update(view.state);
      if (nextMarkdown === null) return;
      // Keep the textarea current on every doc change (not just on submit) so
      // everything reading it — char counter, preview, unload warnings — sees
      // live content. The input event is what the char counter listens for.
      textarea.value = nextMarkdown;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    },
    state: createEditorState(textarea.value),
  });

  const toolbar = createToolbar(view);
  mount.prepend(toolbar.dom);
  // The toolbar's initial highlight is set by the setMode(mode) call below:
  // its rich branch refreshes the toolbar, and a raw start keeps it hidden.

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "md-preview-link md-editor-toggle";

  // Auto-engage rich mode only when the stored markdown provably survives a
  // parse→serialize round trip: in rich mode the first doc change rewrites
  // the whole textarea from the document, which would silently normalize or
  // destroy syntax the schema can't hold (e.g. a GFM table). For such
  // content the field opens raw, and switching to rich stays an explicit
  // toggle click.
  let mode: EditorMode = roundTripsCleanly(textarea.value) ? "rich" : "raw";
  const setMode = (next: EditorMode): void => {
    mode = next;
    const raw = next === "raw";
    textarea.classList.toggle(HIDDEN_CLASS, !raw);
    mount.classList.toggle(HIDDEN_CLASS, raw);
    toggle.textContent = TOGGLE_LABELS[next];
    // Raw-mode edits happen directly in the textarea, so entering rich mode
    // rebuilds the document from the textarea's current markdown.
    if (!raw) {
      view.updateState(createEditorState(textarea.value));
      toolbar.update(view.state);
    }
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
    mount.after(toggle);
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
