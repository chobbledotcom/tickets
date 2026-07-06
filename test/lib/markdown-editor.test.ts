/**
 * Behavioural tests for the rich markdown editor
 * (`src/ui/client/admin/markdown-editor*.ts`, served as `/markdown-editor.js`
 * and injected by the admin bundle's loader).
 *
 * The editor is browser code built on ProseMirror, so these tests run it
 * inside a happy-dom `Window` installed onto the globals the modules read.
 * Rich-editing interactions go through the real `EditorView`: commands are
 * invoked exactly as the keymap would, and input rules are triggered through
 * the view's `handleTextInput` prop — the same path real typing takes.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { type EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  enhanceMarkdownTextarea,
  initMarkdownEditor,
  type MarkdownEditorHandle,
} from "#src/ui/client/admin/markdown-editor.ts";
import { initMarkdownEditorLoader } from "#src/ui/client/admin/markdown-editor-loader.ts";
import {
  createEditorState,
  editorKeymap,
  parseMarkdown,
  roundTripsCleanly,
  serializeMarkdown,
} from "#src/ui/client/admin/markdown-editor-setup.ts";
import { TOOLBAR_ITEMS } from "#src/ui/client/admin/markdown-editor-toolbar.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller([
  "navigator",
  "getComputedStyle",
  "MutationObserver",
  "Event",
]);

afterEach(cleanup);

const TEXTAREA = "<textarea data-markdown-preview>%s</textarea>";
const FOOTER =
  '<div class="md-editor-footer"><button type="button">Preview</button></div>';

/** Install a lone markdown textarea (optionally followed by a footer strip,
 * as the preview module lays out) and enhance it. */
const enhanced = (
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

/** Feed text through the view's input-rule pipeline one character at a time,
 * inserting it verbatim when no rule claims it — i.e. simulate typing. */
const typeText = (view: EditorView, text: string): void => {
  for (const char of text) {
    const { from, to } = view.state.selection;
    const insert = (): ReturnType<typeof view.state.tr.insertText> =>
      view.state.tr.insertText(char, from, to);
    const handled = view.someProp("handleTextInput", (f) =>
      f(view, from, to, char, insert),
    );
    if (!handled) view.dispatch(insert());
  }
};

/** Move the editor selection (a caret when `to` is omitted). */
const select = (view: EditorView, from: number, to = from): void => {
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
  );
};

/** The toolbar button carrying the `md-toolbar-<key>` modifier class. */
const toolbarButton = (
  window: Window,
  key: string,
): HTMLButtonElement & { click: () => void } =>
  window.document.querySelector(
    `.md-toolbar-${key}`,
  ) as unknown as HTMLButtonElement & { click: () => void };

const isActive = (button: HTMLButtonElement): boolean =>
  button.classList.contains("md-toolbar-button-active");

/** Override the window's `prompt` (not typed on happy-dom's Window). */
const setPrompt = (
  window: Window,
  fn: (message?: string) => string | null,
): void => {
  (window as unknown as { prompt: typeof fn }).prompt = fn;
};

/** Assert the contenteditable surface, not a toolbar button, holds focus. */
const expectEditorFocused = (window: Window): void => {
  expect(window.document.activeElement).toBe(
    window.document.querySelector(".md-editor .ProseMirror"),
  );
};

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

describe("markdown editor input rules", () => {
  test("typing '- ' starts a bullet list", () => {
    const { handle, textarea } = enhanced("");
    typeText(handle.view, "- milk");
    expect(handle.view.state.doc.firstChild?.type.name).toBe("bullet_list");
    expect(textarea.value).toBe("* milk");
  });

  test("typing '3. ' starts an ordered list at 3", () => {
    const { handle, textarea } = enhanced("");
    typeText(handle.view, "3. third");
    const list = handle.view.state.doc.firstChild;
    expect(list?.type.name).toBe("ordered_list");
    expect(list?.attrs.order).toBe(3);
    expect(textarea.value).toBe("3. third");
  });

  test("typing '> ' starts a blockquote", () => {
    const { handle, textarea } = enhanced("");
    typeText(handle.view, "> wise");
    expect(handle.view.state.doc.firstChild?.type.name).toBe("blockquote");
    expect(textarea.value).toBe("> wise");
  });

  test("typing '## ' makes a level-two heading", () => {
    const { handle, textarea } = enhanced("");
    typeText(handle.view, "## Head");
    const heading = handle.view.state.doc.firstChild;
    expect(heading?.type.name).toBe("heading");
    expect(heading?.attrs.level).toBe(2);
    expect(textarea.value).toBe("## Head");
  });

  test("typing ``` makes a code block", () => {
    const { handle, textarea } = enhanced("");
    typeText(handle.view, "```code");
    expect(handle.view.state.doc.firstChild?.type.name).toBe("code_block");
    expect(textarea.value).toBe("```\ncode\n```");
  });

  test("typing [text](url) creates a link", () => {
    const { handle, textarea } = enhanced("");
    typeText(handle.view, "[docs](/admin/formatting)");
    const text = handle.view.state.doc.firstChild?.firstChild;
    expect(text?.marks[0]?.type.name).toBe("link");
    expect(text?.marks[0]?.attrs.href).toBe("/admin/formatting");
    expect(textarea.value).toBe("[docs](/admin/formatting)");
  });
});

describe("enhanceMarkdownTextarea", () => {
  test("mounts a rich editor over the textarea's markdown", () => {
    const { handle, textarea, window } = enhanced("Some **bold** words");
    const mount = window.document.querySelector(".md-editor");
    expect(mount).not.toBeNull();
    expect(textarea.classList.contains("md-editor-hidden")).toBe(true);
    expect(mount?.classList.contains("md-editor-hidden")).toBe(false);
    expect(serializeMarkdown(handle.view.state.doc)).toBe(
      "Some **bold** words",
    );
    expect(mount?.querySelector("strong")?.textContent).toBe("bold");
  });

  test("puts its toggle at the start of the preview footer when present", () => {
    const { window } = enhanced("", { footer: true });
    const footer = window.document.querySelector(".md-editor-footer");
    const toggle = footer?.firstElementChild;
    expect(toggle?.classList.contains("md-editor-toggle")).toBe(true);
    expect(toggle?.textContent).toBe("Edit markdown");
    // Anything else would make it a submit button inside the form.
    expect(toggle?.getAttribute("type")).toBe("button");
  });

  test("puts its toggle after the editor when there is no footer", () => {
    const { window } = enhanced("");
    const mount = window.document.querySelector(".md-editor");
    expect(
      mount?.nextElementSibling?.classList.contains("md-editor-toggle"),
    ).toBe(true);
  });

  test("ignores a next sibling that is not the footer strip", () => {
    const window = installDom(
      '<textarea data-markdown-preview></textarea><div class="other"></div>',
    );
    const textarea = window.document.querySelector(
      "textarea",
    ) as unknown as HTMLTextAreaElement;
    enhanceMarkdownTextarea(textarea);
    // The sibling was not mistaken for a footer strip: the toggle went after
    // the editor mount instead of inside the div.
    expect(window.document.querySelector(".other")?.childElementCount).toBe(0);
    expect(
      window.document
        .querySelector(".md-editor")
        ?.nextElementSibling?.classList.contains("md-editor-toggle"),
    ).toBe(true);
  });

  test("serializes rich edits back into the textarea as markdown", () => {
    const { handle, textarea } = enhanced("hello");
    handle.view.dispatch(handle.view.state.tr.insertText("Oh ", 1));
    expect(textarea.value).toBe("Oh hello");
  });

  test("announces rich edits as input events for the char counter", () => {
    const { handle, textarea } = enhanced("hello");
    let inputs = 0;
    textarea.addEventListener("input", () => {
      inputs += 1;
    });
    handle.view.dispatch(handle.view.state.tr.insertText("!", 6));
    expect(inputs).toBe(1);
  });

  test("the input events bubble up to the textarea's form", () => {
    const window = installDom(
      "<form><textarea data-markdown-preview>hello</textarea></form>",
    );
    const textarea = window.document.querySelector(
      "textarea",
    ) as unknown as HTMLTextAreaElement;
    const handle = enhanceMarkdownTextarea(textarea);
    let formInputs = 0;
    window.document.querySelector("form")?.addEventListener("input", () => {
      formInputs += 1;
    });
    handle.view.dispatch(handle.view.state.tr.insertText("!", 6));
    expect(formInputs).toBe(1);
  });

  test("leaves the textarea alone on selection-only transactions", () => {
    const { handle, textarea } = enhanced("hello");
    textarea.value = "sentinel";
    let inputs = 0;
    textarea.addEventListener("input", () => {
      inputs += 1;
    });
    handle.view.dispatch(
      handle.view.state.tr.setSelection(
        TextSelection.create(handle.view.state.doc, 2),
      ),
    );
    expect(inputs).toBe(0);
    expect(textarea.value).toBe("sentinel");
  });

  test("the toggle switches to the raw textarea and back", () => {
    const { textarea, window } = enhanced("hello", { footer: true });
    const toggle = window.document.querySelector(
      ".md-editor-toggle",
    ) as unknown as HTMLElement;
    const mount = window.document.querySelector(".md-editor");

    toggle.click();
    expect(textarea.classList.contains("md-editor-hidden")).toBe(false);
    expect(mount?.classList.contains("md-editor-hidden")).toBe(true);
    expect(toggle.textContent).toBe("Edit visually");

    toggle.click();
    expect(textarea.classList.contains("md-editor-hidden")).toBe(true);
    expect(mount?.classList.contains("md-editor-hidden")).toBe(false);
    expect(toggle.textContent).toBe("Edit markdown");
  });

  test("re-parses raw-mode textarea edits when switching back to rich", () => {
    const { handle, textarea } = enhanced("plain");
    handle.setMode("raw");
    textarea.value = "* switched";
    handle.setMode("rich");
    expect(handle.view.state.doc.firstChild?.type.name).toBe("bullet_list");
  });

  test("opens in raw mode when the content would not survive rich editing", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    const { textarea, window } = enhanced(table, { footer: true });
    expect(textarea.classList.contains("md-editor-hidden")).toBe(false);
    expect(
      window.document
        .querySelector(".md-editor")
        ?.classList.contains("md-editor-hidden"),
    ).toBe(true);
    expect(
      window.document.querySelector(".md-editor-toggle")?.textContent,
    ).toBe("Edit visually");
    expect(textarea.value).toBe(table);
  });

  test("rich mode stays an explicit toggle for non-round-tripping content", () => {
    const { handle, textarea, window } = enhanced("- one", { footer: true });
    (
      window.document.querySelector(".md-editor-toggle") as unknown as {
        click: () => void;
      }
    ).click();
    expect(textarea.classList.contains("md-editor-hidden")).toBe(true);
    expect(handle.view.state.doc.firstChild?.type.name).toBe("bullet_list");
  });

  test("reveals the textarea when a hidden required field blocks submit", () => {
    const { textarea, window } = enhanced("");
    textarea.dispatchEvent(new window.Event("invalid") as unknown as Event);
    expect(textarea.classList.contains("md-editor-hidden")).toBe(false);
    expect(
      window.document
        .querySelector(".md-editor")
        ?.classList.contains("md-editor-hidden"),
    ).toBe(true);
  });
});

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

describe("markdown editor maxlength", () => {
  const withMaxlength = (value: string, max: number) => {
    const window = installDom(
      `<textarea data-markdown-preview maxlength="${max}">${value}</textarea>`,
    );
    const textarea = window.document.querySelector(
      "textarea",
    ) as unknown as HTMLTextAreaElement;
    return { handle: enhanceMarkdownTextarea(textarea), textarea, window };
  };

  test("rejects an edit that grows the markdown past the field's maxlength", () => {
    const { handle, textarea } = withMaxlength("hello", 8);
    handle.view.dispatch(handle.view.state.tr.insertText("world!!", 6));
    expect(textarea.value).toBe("hello");
    expect(serializeMarkdown(handle.view.state.doc)).toBe("hello");
  });

  test("still allows deletions when the content already exceeds maxlength", () => {
    const { handle, textarea } = withMaxlength("abcdefgh", 5);
    handle.view.dispatch(handle.view.state.tr.delete(7, 9));
    expect(textarea.value).toBe("abcdef");
    expect(serializeMarkdown(handle.view.state.doc)).toBe("abcdef");
  });

  test("permits edits that stay within the limit", () => {
    const { handle, textarea } = withMaxlength("hi", 8);
    handle.view.dispatch(handle.view.state.tr.insertText("!", 3));
    expect(textarea.value).toBe("hi!");
  });

  test("enforces a maxlength of one (the guard is > 0, not > 1)", () => {
    const { handle, textarea } = withMaxlength("a", 1);
    handle.view.dispatch(handle.view.state.tr.insertText("b", 2));
    expect(textarea.value).toBe("a");
  });

  test("does not limit a field with no maxlength attribute", () => {
    const window = installDom("<textarea data-markdown-preview>hi</textarea>");
    const textarea = window.document.querySelector(
      "textarea",
    ) as unknown as HTMLTextAreaElement;
    const handle = enhanceMarkdownTextarea(textarea);
    handle.view.dispatch(
      handle.view.state.tr.insertText("everything is allowed here", 3),
    );
    expect(textarea.value).toBe("hieverything is allowed here");
  });
});

describe("initMarkdownEditor", () => {
  test("enhances every markdown textarea on the page", () => {
    const window = installDom(
      "<textarea data-markdown-preview>one</textarea><textarea data-markdown-preview>two</textarea>",
    );
    initMarkdownEditor();
    expect(window.document.querySelectorAll(".md-editor").length).toBe(2);
  });

  test("leaves plain textareas alone", () => {
    const window = installDom("<textarea></textarea>");
    initMarkdownEditor();
    expect(window.document.querySelector(".md-editor")).toBeNull();
  });
});

describe("initMarkdownEditorLoader", () => {
  test("injects the editor bundle when the page has a markdown textarea", () => {
    const window = installDom("<textarea data-markdown-preview></textarea>");
    initMarkdownEditorLoader();
    const script = window.document.head.querySelector("script");
    expect(script?.getAttribute("src")).toBe("/markdown-editor.js");
    expect(script?.hasAttribute("defer")).toBe(true);
  });

  test("reuses the admin bundle's cache-busting query", () => {
    const window = installDom(
      '<script src="/admin.js?ts=1234"></script><textarea data-markdown-preview></textarea>',
    );
    initMarkdownEditorLoader();
    expect(
      window.document.head.querySelector("script[defer]")?.getAttribute("src"),
    ).toBe("/markdown-editor.js?ts=1234");
  });

  test("adds no query when the admin bundle has none", () => {
    const window = installDom(
      '<script src="/admin.js"></script><textarea data-markdown-preview></textarea>',
    );
    initMarkdownEditorLoader();
    expect(
      window.document.head.querySelector("script[defer]")?.getAttribute("src"),
    ).toBe("/markdown-editor.js");
  });

  test("does not load the bundle on pages without markdown fields", () => {
    const window = installDom("<textarea></textarea>");
    initMarkdownEditorLoader();
    expect(window.document.head.querySelector("script")).toBeNull();
  });
});
