/**
 * The markdown editor toolbar
 * (`src/ui/client/admin/markdown-editor-toolbar.ts`): the rendered controls,
 * their commands, and the active-state predicates, exercised through the
 * real editor mount and directly against `TOOLBAR_ITEMS`.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { type EditorState, TextSelection } from "prosemirror-state";
import { createEditorState } from "#src/ui/client/admin/markdown-editor-setup.ts";
import { TOOLBAR_ITEMS } from "#src/ui/client/admin/markdown-editor-toolbar.ts";
import {
  cleanup,
  enhanced,
  expectEditorFocused,
  isActive,
  select,
  setPrompt,
  toolbarButton,
} from "#test-utils/markdown-editor-dom.ts";

afterEach(cleanup);

/** Build a state with the caret at `pos` for direct predicate assertions. */
const stateAt = (markdown: string, pos: number): EditorState => {
  const state = createEditorState(markdown);
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, pos)),
  );
};

/** Evaluate a toolbar item's `isActive` predicate directly. */
const itemActive = (key: string, state: EditorState): boolean =>
  TOOLBAR_ITEMS.find((item) => item.key === key)!.isActive(state);

describe("markdown editor toolbar", () => {
  test("renders the formatting controls above the editor", () => {
    const { window } = enhanced("hello");
    expect(
      window.document.querySelector(".md-editor .md-toolbar"),
    ).not.toBeNull();
    const buttons = [
      ...window.document.querySelectorAll(".md-toolbar-button"),
    ] as unknown as HTMLButtonElement[];
    // Real <button type> matters: an empty/attr-less type defaults to "submit",
    // which would submit the surrounding form on every click.
    expect(buttons.map((b) => b.getAttribute("type"))).toEqual(
      buttons.map(() => "button"),
    );
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Bold",
      "Italic",
      "Link",
      "Heading",
      "Bulleted list",
      "Numbered list",
      "Quote",
    ]);
    expect(buttons.map((b) => b.textContent)).toEqual([
      "B",
      "I",
      "Link",
      "H2",
      "• List",
      "1. List",
      "Quote",
    ]);
  });

  test("its buttons preserve the editor selection via mousedown", () => {
    const { window } = enhanced("hello");
    const event = new window.Event("mousedown", {
      bubbles: true,
      cancelable: true,
    }) as unknown as Event;
    toolbarButton(window, "bold").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test("isActive predicates return strict booleans per control", () => {
    expect(itemActive("bold", stateAt("**bb**", 2))).toBe(true);
    expect(itemActive("bold", stateAt("plain", 3))).toBe(false);
    expect(itemActive("italic", stateAt("*ii*", 2))).toBe(true);
    expect(itemActive("italic", stateAt("plain", 3))).toBe(false);
    expect(itemActive("link", stateAt("[xx](/y)", 2))).toBe(true);
    expect(itemActive("link", stateAt("plain", 3))).toBe(false);
    expect(itemActive("bullet", stateAt("* one", 3))).toBe(true);
    expect(itemActive("bullet", stateAt("plain", 3))).toBe(false);
    expect(itemActive("ordered", stateAt("1. one", 4))).toBe(true);
    expect(itemActive("ordered", stateAt("plain", 3))).toBe(false);
    expect(itemActive("quote", stateAt("> hi", 3))).toBe(true);
    expect(itemActive("quote", stateAt("plain", 3))).toBe(false);
    expect(itemActive("heading", stateAt("## two", 3))).toBe(true);
    expect(itemActive("heading", stateAt("# one", 3))).toBe(false);
  });

  test("highlights the controls active at the caret on load", () => {
    // Exercises the initial toolbar refresh: the caret opens in the heading.
    const { window } = enhanced("## Head");
    expect(isActive(toolbarButton(window, "heading"))).toBe(true);
    expect(isActive(toolbarButton(window, "bold"))).toBe(false);
  });

  test("the bold button wraps the selection in strong and syncs the textarea", () => {
    const { handle, textarea, window } = enhanced("hello");
    select(handle.view, 1, 6);
    toolbarButton(window, "bold").click();
    expect(textarea.value).toBe("**hello**");
    // The just-bolded selection is now active (the doc-change refreshes the
    // toolbar), and focus returns to the editor rather than the button.
    expect(isActive(toolbarButton(window, "bold"))).toBe(true);
    expectEditorFocused(window);
  });

  test("the italic button wraps the selection in emphasis", () => {
    const { handle, textarea, window } = enhanced("hello");
    select(handle.view, 1, 6);
    toolbarButton(window, "italic").click();
    expect(textarea.value).toBe("*hello*");
  });

  test("the heading button toggles a heading on and back off", () => {
    const { handle, textarea, window } = enhanced("hello");
    select(handle.view, 3);
    toolbarButton(window, "heading").click();
    expect(textarea.value).toBe("## hello");
    expectEditorFocused(window);
    toolbarButton(window, "heading").click();
    expect(textarea.value).toBe("hello");
  });

  test("the bulleted and numbered list buttons wrap the block", () => {
    const bullet = enhanced("one");
    select(bullet.handle.view, 2);
    toolbarButton(bullet.window, "bullet").click();
    expect(bullet.textarea.value).toBe("* one");

    const ordered = enhanced("one");
    select(ordered.handle.view, 2);
    toolbarButton(ordered.window, "ordered").click();
    expect(ordered.textarea.value).toBe("1. one");
  });

  test("the quote button wraps the block in a blockquote", () => {
    const { handle, textarea, window } = enhanced("hi");
    select(handle.view, 2);
    toolbarButton(window, "quote").click();
    expect(textarea.value).toBe("> hi");
  });

  test("the link button prompts for a URL and applies it", () => {
    const { handle, textarea, window } = enhanced("word");
    let promptMessage = "";
    setPrompt(window, (message) => {
      promptMessage = message ?? "";
      return "/target";
    });
    select(handle.view, 1, 5);
    toolbarButton(window, "link").click();
    expect(promptMessage).toBe("Link URL");
    expect(textarea.value).toBe("[word](/target)");
    expectEditorFocused(window);
  });

  test("the link button leaves the text unchanged when the prompt is dismissed", () => {
    const { handle, textarea, window } = enhanced("word");
    setPrompt(window, () => null);
    select(handle.view, 1, 5);
    toolbarButton(window, "link").click();
    expect(textarea.value).toBe("word");
  });

  test("the link button strips an existing link at the cursor", () => {
    const { handle, textarea, window } = enhanced("[word](/y)");
    select(handle.view, 1, 5);
    toolbarButton(window, "link").click();
    expect(textarea.value).toBe("word");
  });

  test("the bold button reflects whether the caret sits in bold text", () => {
    const { handle, window } = enhanced("plain **bold**");
    // Caret in the plain run: not active. This is the case a naive
    // `isInSet(...) !== null` check wrongly reports as always active.
    select(handle.view, 3);
    expect(isActive(toolbarButton(window, "bold"))).toBe(false);
    // Caret inside the bold run: active.
    select(handle.view, 9);
    expect(isActive(toolbarButton(window, "bold"))).toBe(true);
  });

  test("the bold button reflects a selection that spans bold text", () => {
    const { handle, window } = enhanced("plain **bold**");
    select(handle.view, 1, 6); // over "plain"
    expect(isActive(toolbarButton(window, "bold"))).toBe(false);
    select(handle.view, 7, 11); // over "bold"
    expect(isActive(toolbarButton(window, "bold"))).toBe(true);
  });

  test("the heading button is active only for its own level", () => {
    const h2 = enhanced("## Two");
    select(h2.handle.view, 2);
    expect(isActive(toolbarButton(h2.window, "heading"))).toBe(true);

    const h1 = enhanced("# One");
    select(h1.handle.view, 2);
    expect(isActive(toolbarButton(h1.window, "heading"))).toBe(false);
  });

  test("the list and quote buttons reflect the block at the cursor", () => {
    const list = enhanced("* one");
    select(list.handle.view, 3);
    expect(isActive(toolbarButton(list.window, "bullet"))).toBe(true);
    expect(isActive(toolbarButton(list.window, "quote"))).toBe(false);

    const quote = enhanced("> hi");
    select(quote.handle.view, 3);
    expect(isActive(toolbarButton(quote.window, "quote"))).toBe(true);
    expect(isActive(toolbarButton(quote.window, "bullet"))).toBe(false);
  });

  test("refreshes the active controls after switching back from raw mode", () => {
    const { handle, textarea, window } = enhanced("plain");
    expect(isActive(toolbarButton(window, "heading"))).toBe(false);
    handle.setMode("raw");
    textarea.value = "## Now a heading";
    handle.setMode("rich");
    // Without the toolbar refresh in setMode this would still read the old
    // paragraph state.
    expect(isActive(toolbarButton(window, "heading"))).toBe(true);
  });
});
