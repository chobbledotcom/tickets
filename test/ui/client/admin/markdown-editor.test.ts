/**
 * Behavioural tests for the rich markdown editor
 * (`src/ui/client/admin/markdown-editor.ts`, served as `/markdown-editor.js`
 * and injected by the admin bundle's loader).
 *
 * The editor is browser code built on ProseMirror, so these tests run it
 * inside a happy-dom `Window` installed onto the globals the modules read.
 * Rich-editing interactions go through the real `EditorView`: input rules
 * are triggered through the view's `handleTextInput` prop — the same path
 * real typing takes. The document layer and the toolbar have their own
 * mirrored suites (`markdown-editor-setup.test.ts`,
 * `markdown-editor-toolbar.test.ts`).
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  enhanceMarkdownTextarea,
  initMarkdownEditor,
} from "#src/ui/client/admin/markdown-editor.ts";
import { serializeMarkdown } from "#src/ui/client/admin/markdown-editor-setup.ts";
import {
  cleanup,
  enhanced,
  installDom,
} from "#test-utils/markdown-editor-dom.ts";

afterEach(cleanup);

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
