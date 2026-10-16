/**
 * ProseMirror configuration for the rich markdown editor — the pure, DOM-free
 * half (`markdown-editor.ts` is the DOM shell).
 *
 * The CommonMark schema and markdown-it parser make the document model exactly
 * the markdown the server renders with `#shared/markdown.ts`. Rendering and
 * sanitisation stay server-side. This module only converts between markdown
 * text and the editing document.
 */

import {
  baseKeymap,
  chainCommands,
  exitCode,
  toggleMark,
} from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  schema,
} from "prosemirror-markdown";
import type { Node } from "prosemirror-model";
import {
  liftListItem,
  sinkListItem,
  splitListItem,
} from "prosemirror-schema-list";
import { type Command, EditorState, type Transaction } from "prosemirror-state";

/** Parse markdown text into an editing document. */
export const parseMarkdown = (text: string): Node =>
  defaultMarkdownParser.parse(text);

/** Serialize an editing document back to markdown text. */
export const serializeMarkdown = (doc: Node): string =>
  defaultMarkdownSerializer.serialize(doc);

/**
 * True when the markdown survives a parse→serialize round trip unchanged
 * (modulo outer whitespace) — i.e. the rich editor can hold it without
 * rewriting anything. False for syntax outside the CommonMark schema (GFM
 * tables collapse to a paragraph) and for spellings the serializer would
 * normalize (`- ` bullets become `* `), where a rich-mode edit anywhere in
 * the field would silently rewrite the stored text.
 */
export const roundTripsCleanly = (text: string): boolean =>
  serializeMarkdown(parseMarkdown(text)).trim() === text.trim();

/** Insert a hard line break (Shift-Enter), leaving code blocks first. */
const insertHardBreak: Command = chainCommands(exitCode, (state, dispatch) => {
  dispatch?.(
    state.tr
      .replaceSelectionWith(schema.nodes.hard_break.create())
      .scrollIntoView(),
  );
  return true;
});

/**
 * Fix the attrs of a fresh nested list on the sunk transaction. The list
 * around the caret gets `tight: true` when the document before the command
 * holds no list of the same type at the mapped-back position. A list the
 * command reused instead of creating keeps its own flag.
 */
const tightenFreshNestedList = (before: Node, tr: Transaction): Transaction => {
  const back = tr.mapping.invert();
  const $from = tr.selection.$from;
  let fixed = tr;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (
      node.type !== schema.nodes.bullet_list &&
      node.type !== schema.nodes.ordered_list
    ) {
      continue;
    }
    if (!node.attrs.tight) {
      const start = $from.before(depth);
      const oldNode = before.nodeAt(back.map(start, -1));
      if (oldNode?.type !== node.type) {
        fixed = fixed.setNodeMarkup(start, undefined, {
          ...node.attrs,
          tight: true,
        });
      }
    }
    break;
  }
  return fixed;
};

/**
 * Tab: sink the list item. A nested list the command creates anew carries
 * the schema's `tight: false` default. The serializer writes a blank line
 * between the items of such a list, so the attrs are fixed on the command's
 * own transaction.
 */
const sinkListItemTight = (): Command => (state, dispatch) => {
  if (!dispatch) return sinkListItem(schema.nodes.list_item)(state);
  const ok = sinkListItem(schema.nodes.list_item)(state, (tr: Transaction) => {
    dispatch(tightenFreshNestedList(state.doc, tr));
  });
  return ok;
};

/**
 * The editor's own key bindings; `baseKeymap` (added separately, after this
 * map) handles everything else, so each binding here only needs to cover its
 * specific structure and can fall through by returning false.
 */
export const editorKeymap = (): Record<string, Command> => ({
  Backspace: undoInputRule,
  Enter: splitListItem(schema.nodes.list_item),
  "Mod-b": toggleMark(schema.marks.strong),
  "Mod-i": toggleMark(schema.marks.em),
  "Mod-y": redo,
  "Mod-z": undo,
  "Shift-Enter": insertHardBreak,
  "Shift-Mod-z": redo,
  "Shift-Tab": liftListItem(schema.nodes.list_item),
  Tab: sinkListItemTight(),
});

/** Typing `[text](url)` converts to a real link, matching the markdown
 * syntax the formatting-help page teaches. */
const linkRule = (): InputRule =>
  new InputRule(/\[([^\]]+)\]\(([^()\s]+)\)$/, (state, match, start, end) =>
    state.tr.replaceWith(
      start,
      end,
      schema.text(match[1]!, [schema.marks.link.create({ href: match[2]! })]),
    ),
  );

/** Markdown-style block shortcuts: `- `, `1. `, `> `, `# `–`###### `, ```. */
export const editorInputRules = (): InputRule[] => [
  // The markdown schema defaults new lists to `tight: false`, which the
  // serializer writes out with a blank line between the items. Lists the
  // user builds by typing stay tight.
  wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list, () => ({
    tight: true,
  })),
  wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, (match) => ({
    order: Number(match[1]),
    tight: true,
  })),
  wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
  textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (match) => ({
    level: match[1]!.length,
  })),
  textblockTypeInputRule(/^```$/, schema.nodes.code_block),
  linkRule(),
];

/** Build a fresh editor state from markdown text, with all plugins wired. */
export const createEditorState = (markdown: string): EditorState =>
  EditorState.create({
    doc: parseMarkdown(markdown),
    plugins: [
      inputRules({ rules: editorInputRules() }),
      keymap(editorKeymap()),
      keymap(baseKeymap),
      history(),
    ],
  });
