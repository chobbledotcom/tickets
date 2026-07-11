/// <reference lib="dom" />
/**
 * Toolbar for the rich markdown editor — a row of formatting buttons (bold,
 * italic, link, heading, bulleted/numbered list, quote) above the editing
 * surface, so the available formatting is discoverable without knowing the
 * keyboard shortcuts or markdown syntax.
 *
 * Modeled as a typed `TOOLBAR_ITEMS` list folded into buttons: each item
 * carries the ProseMirror command it runs and an `isActive` predicate that
 * decides whether its button is highlighted at the current cursor. Adding a
 * control is a data edit, not new wiring. The active state is refreshed on
 * every transaction by the editor's dispatch handler.
 */

import { setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { schema } from "prosemirror-markdown";
import type { MarkType, NodeType } from "prosemirror-model";
import { wrapInList } from "prosemirror-schema-list";
import type { Command, EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

const { marks, nodes } = schema;

/** True when `type` is active across the selection (or stored for an empty
 * selection, so a just-clicked Bold button lights up before typing). */
export const markActive = (state: EditorState, type: MarkType): boolean => {
  const { empty, $from, from, to } = state.selection;
  // isInSet returns the Mark or undefined, so coerce — not `!== null`, which
  // undefined would always satisfy.
  return empty
    ? Boolean(type.isInSet(state.storedMarks || $from.marks()))
    : state.doc.rangeHasMark(from, to, type);
};

/** True when any ancestor of the selection head is a node of `type` — used for
 * list-membership and blockquote highlighting. */
const inAncestor =
  (type: NodeType) =>
  (state: EditorState): boolean => {
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type === type) return true;
    }
    return false;
  };

/** True when the selection's textblock is a heading of `level`. */
const headingActive =
  (level: number) =>
  (state: EditorState): boolean => {
    const parent = state.selection.$from.parent;
    return parent.type === nodes.heading && parent.attrs.level === level;
  };

/** Run a plain command against the view, then return focus to the editor. */
const runCommand =
  (command: Command) =>
  (view: EditorView): void => {
    command(view.state, view.dispatch, view);
    view.focus();
  };

/** Toggle a heading of `level`: set it, or drop back to a paragraph when the
 * block already is that heading. */
const toggleHeading =
  (level: number) =>
  (view: EditorView): void => {
    const command = headingActive(level)(view.state)
      ? setBlockType(nodes.paragraph)
      : setBlockType(nodes.heading, { level });
    command(view.state, view.dispatch, view);
    view.focus();
  };

/** Toggle a link: strip an existing one, else prompt for a URL and apply it. */
const toggleLink = (view: EditorView): void => {
  const type = marks.link;
  if (markActive(view.state, type)) {
    toggleMark(type)(view.state, view.dispatch);
  } else {
    const href = window.prompt("Link URL");
    if (href) toggleMark(type, { href })(view.state, view.dispatch);
  }
  view.focus();
};

export interface ToolbarItem {
  /** Whether the button is highlighted for the given state. */
  isActive: (state: EditorState) => boolean;
  /** Stable identifier, also the button's `md-toolbar-<key>` modifier class. */
  key: string;
  /** Accessible name (title + aria-label). */
  label: string;
  /** Invoked on click. */
  run: (view: EditorView) => void;
  /** Visible button text. */
  text: string;
}

export const TOOLBAR_ITEMS: ToolbarItem[] = [
  {
    isActive: (state) => markActive(state, marks.strong),
    key: "bold",
    label: "Bold",
    run: runCommand(toggleMark(marks.strong)),
    text: "B",
  },
  {
    isActive: (state) => markActive(state, marks.em),
    key: "italic",
    label: "Italic",
    run: runCommand(toggleMark(marks.em)),
    text: "I",
  },
  {
    isActive: (state) => markActive(state, marks.link),
    key: "link",
    label: "Link",
    run: toggleLink,
    text: "Link",
  },
  {
    isActive: headingActive(2),
    key: "heading",
    label: "Heading",
    run: toggleHeading(2),
    text: "H2",
  },
  {
    isActive: inAncestor(nodes.bullet_list),
    key: "bullet",
    label: "Bulleted list",
    run: runCommand(wrapInList(nodes.bullet_list)),
    text: "• List",
  },
  {
    isActive: inAncestor(nodes.ordered_list),
    key: "ordered",
    label: "Numbered list",
    run: runCommand(wrapInList(nodes.ordered_list)),
    text: "1. List",
  },
  {
    isActive: inAncestor(nodes.blockquote),
    key: "quote",
    label: "Quote",
    run: runCommand(wrapIn(nodes.blockquote)),
    text: "Quote",
  },
];

/** Class toggled on a button whose formatting is active at the cursor. */
const ACTIVE_CLASS = "md-toolbar-button-active";

export interface Toolbar {
  dom: HTMLElement;
  /** Refresh every button's active highlight for the given state. */
  update: (state: EditorState) => void;
}

/** Build the toolbar DOM for one editor view. */
export const createToolbar = (view: EditorView): Toolbar => {
  const dom = document.createElement("div");
  dom.className = "md-toolbar";
  const buttons = TOOLBAR_ITEMS.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `md-toolbar-button md-toolbar-${item.key}`;
    button.textContent = item.text;
    button.title = item.label;
    button.setAttribute("aria-label", item.label);
    // Preserve the editor selection: a mousedown that shifts focus to the
    // button would collapse it before the command runs.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => item.run(view));
    dom.appendChild(button);
    return { button, item };
  });
  return {
    dom,
    update: (state) => {
      for (const { button, item } of buttons) {
        button.classList.toggle(ACTIVE_CLASS, item.isActive(state));
      }
    },
  };
};
