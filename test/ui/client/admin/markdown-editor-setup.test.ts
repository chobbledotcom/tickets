/**
 * The markdown editor's document layer
 * (`src/ui/client/admin/markdown-editor-setup.ts`): parse/serialize
 * round-trips, the clean-round-trip predicate that decides the opening mode,
 * and the keymap commands, exercised directly against editor states.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { TextSelection } from "prosemirror-state";
import {
  createEditorState,
  editorKeymap,
  parseMarkdown,
  roundTripsCleanly,
  serializeMarkdown,
} from "#src/ui/client/admin/markdown-editor-setup.ts";

describe("markdown editor setup", () => {
  test("round-trips the promised formatting through parse and serialize", () => {
    const source =
      "# Title\n\nSome **bold** and *italic* with a [link](https://example.com).\n\n* one\n* two";
    expect(serializeMarkdown(parseMarkdown(source))).toBe(source);
  });

  test("round-trips Liquid placeholders untouched", () => {
    const source = "Hi {{ attendee_name }}, see {{ listing_name }}.";
    expect(serializeMarkdown(parseMarkdown(source))).toBe(source);
  });

  test("serializes an empty document to an empty string", () => {
    expect(serializeMarkdown(parseMarkdown(""))).toBe("");
  });

  test("recognises markdown the editor can hold without rewriting", () => {
    expect(roundTripsCleanly("Some **bold** with a [link](/x)\n\n* one")).toBe(
      true,
    );
    expect(roundTripsCleanly("Hi {{ attendee_name }}")).toBe(true);
    expect(roundTripsCleanly("")).toBe(true);
  });

  test("recognises markdown a rich-mode edit would rewrite", () => {
    // A GFM table has no CommonMark schema node and collapses to a paragraph.
    expect(roundTripsCleanly("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(false);
    // The serializer normalizes `- ` bullets to `* `.
    expect(roundTripsCleanly("- one\n- two")).toBe(false);
  });

  test("undo and redo walk the edit history", () => {
    const initial = createEditorState("hello");
    const edited = initial.apply(initial.tr.insertText("X", 1));
    expect(serializeMarkdown(edited.doc)).toBe("Xhello");

    let state = edited;
    const dispatch = (tr: Parameters<typeof state.apply>[0]): void => {
      state = state.apply(tr);
    };
    editorKeymap()["Mod-z"]!(state, dispatch);
    expect(serializeMarkdown(state.doc)).toBe("hello");
    editorKeymap()["Mod-y"]!(state, dispatch);
    expect(serializeMarkdown(state.doc)).toBe("Xhello");
    editorKeymap()["Mod-z"]!(state, dispatch);
    editorKeymap()["Shift-Mod-z"]!(state, dispatch);
    expect(serializeMarkdown(state.doc)).toBe("Xhello");
  });

  test("Mod-b bolds and Mod-i italicises the selection", () => {
    const initial = createEditorState("hello");
    let state = initial.apply(
      initial.tr.setSelection(TextSelection.create(initial.doc, 1, 6)),
    );
    const dispatch = (tr: Parameters<typeof state.apply>[0]): void => {
      state = state.apply(tr);
    };
    editorKeymap()["Mod-b"]!(state, dispatch);
    expect(serializeMarkdown(state.doc)).toBe("**hello**");
    editorKeymap()["Mod-i"]!(state, dispatch);
    expect(serializeMarkdown(state.doc)).toBe("***hello***");
  });

  test("Shift-Enter inserts a hard line break", () => {
    const initial = createEditorState("one two");
    let state = initial.apply(
      initial.tr.setSelection(TextSelection.create(initial.doc, 4, 5)),
    );
    editorKeymap()["Shift-Enter"]!(state, (tr) => {
      state = state.apply(tr);
    });
    expect(serializeMarkdown(state.doc)).toBe("one\\\ntwo");
  });

  test("Shift-Enter reports applicable without dispatching", () => {
    const state = createEditorState("one");
    expect(editorKeymap()["Shift-Enter"]!(state)).toBe(true);
    expect(serializeMarkdown(state.doc)).toBe("one");
  });

  test("Shift-Enter exits a code block instead of breaking inside it", () => {
    const initial = createEditorState("```\ncode\n```");
    let state = initial.apply(
      initial.tr.setSelection(TextSelection.create(initial.doc, 5)),
    );
    editorKeymap()["Shift-Enter"]!(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.childCount).toBe(2);
    expect(state.doc.child(0).type.name).toBe("code_block");
    expect(state.doc.child(1).type.name).toBe("paragraph");
  });

  test("Enter splits a list item", () => {
    const initial = createEditorState("* one");
    let state = initial.apply(
      initial.tr.setSelection(TextSelection.create(initial.doc, 6)),
    );
    editorKeymap().Enter!(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.firstChild?.childCount).toBe(2);
  });

  test("Tab nests a list item and Shift-Tab lifts it back", () => {
    const initial = createEditorState("* one\n* two");
    let state = initial.apply(
      initial.tr.setSelection(TextSelection.create(initial.doc, 12)),
    );
    const dispatch = (tr: Parameters<typeof state.apply>[0]): void => {
      state = state.apply(tr);
    };
    expect(state.doc.firstChild?.childCount).toBe(2);
    editorKeymap().Tab!(state, dispatch);
    expect(state.doc.firstChild?.childCount).toBe(1);
    editorKeymap()["Shift-Tab"]!(state, dispatch);
    expect(state.doc.firstChild?.childCount).toBe(2);
  });
});
