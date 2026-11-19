/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Markdown preview: adds a "Preview" link under each markdown field that
 * renders the current content through the admin-only /admin/markdown-preview
 * endpoint and shows it in the shared admin modal.
 *
 * Rendering happens server-side so the preview matches the public page exactly
 * and is sanitised (raw HTML escaped, unsafe URLs stripped) before it reaches
 * the DOM. The request carries the page's CSRF token so it cannot be triggered
 * cross-site. The modal's words come from the inert `<template>` that the
 * admin shell renders.
 */

import { once } from "#fp";
import {
  MARKDOWN_PREVIEW_TEMPLATE_ID,
  type PreviewCopy,
  type PreviewNote,
} from "#shared/markdown-preview.ts";
import { openAdminModal } from "#src/ui/client/admin/modal.ts";
import { cloneContent, requiredChild } from "#src/ui/client/dom.ts";

/** Find the CSRF token for the form a textarea belongs to. */
const csrfTokenFor = (textarea: HTMLTextAreaElement): string =>
  textarea
    .closest("form")
    ?.querySelector<HTMLInputElement>('input[name="csrfToken"]')?.value ?? "";

/** A failed request leaves the field's text intact. */
const fetchPreview = async (
  textarea: HTMLTextAreaElement,
): Promise<string | null> => {
  const body = new URLSearchParams({
    content: textarea.value,
    csrfToken: csrfTokenFor(textarea),
  }).toString();
  try {
    const response = await fetch("/admin/markdown-preview", {
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    return response.ok ? (await response.text()).trim() : null;
  } catch {
    return null;
  }
};

/**
 * The character counter (added earlier by initCharCounters) sits immediately
 * after the textarea. Returns it so it can be moved into the footer, opposite
 * the preview link.
 */
const counterAfter = (textarea: HTMLTextAreaElement): Element | null => {
  const next = textarea.nextElementSibling;
  return next?.classList.contains("char-counter") ? next : null;
};

export const initMarkdownPreview = (): void => {
  const textareas = document.querySelectorAll<HTMLTextAreaElement>(
    "textarea[data-markdown-preview]",
  );
  if (textareas.length === 0) return;

  const template = requiredChild<HTMLTemplateElement>(
    document,
    `template#${MARKDOWN_PREVIEW_TEMPLATE_ID}`,
  );
  const copyFor = (name: PreviewCopy): Element =>
    requiredChild(template.content, `[data-copy="${name}"]`);
  const open = copyFor("open");
  const heading = copyFor("title").textContent;
  const notes: Record<PreviewNote, Element> = {
    empty: copyFor("empty"),
    failed: copyFor("failed"),
    loading: copyFor("loading"),
  };

  for (const [index, textarea] of textareas.entries()) {
    // Capture the counter before inserting the footer, which would otherwise
    // become the textarea's next sibling.
    const counter = counterAfter(textarea);

    const footer = document.createElement("div");
    footer.className = "md-editor-footer";

    const link = cloneContent(open);
    const getContent = once(() => {
      const content = document.createElement("div");
      content.className = "md-preview-content prose";
      return content;
    });
    let request = 0;
    link.addEventListener("click", async () => {
      const preview = openAdminModal(
        {
          collapsedTitle: heading,
          key: `markdown-preview:${index}`,
          title: heading,
        },
        getContent(),
      );
      preview.replaceChildren(cloneContent(notes.loading));
      const current = ++request;
      const html = await fetchPreview(textarea);
      if (current !== request) return;
      if (html === null || html === "") {
        const note = html === null ? notes.failed : notes.empty;
        preview.replaceChildren(cloneContent(note));
      } else {
        preview.innerHTML = html;
      }
    });

    textarea.insertAdjacentElement("afterend", footer);
    footer.append(link);
    if (counter !== null) footer.append(counter);
  }
};
