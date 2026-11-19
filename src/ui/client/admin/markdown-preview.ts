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

import {
  MARKDOWN_PREVIEW_TEMPLATE_ID,
  type PreviewCopy,
} from "#shared/markdown-preview.ts";
import { openAdminModal } from "#src/ui/client/admin/modal.ts";
import { copyNode, requiredChild } from "#src/ui/client/dom.ts";

/** Find the CSRF token for the form a textarea belongs to. */
const csrfTokenFor = (textarea: HTMLTextAreaElement): string =>
  textarea
    .closest("form")
    ?.querySelector<HTMLInputElement>('input[name="csrfToken"]')?.value ?? "";

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
    copyNode(requiredChild(template.content, `[data-copy="${name}"]`));
  const heading = copyFor("title").textContent;

  const requestPreview = async (
    textarea: HTMLTextAreaElement,
  ): Promise<void> => {
    const content = document.createElement("div");
    content.className = "md-preview-content prose";
    const modal = openAdminModal(
      {
        collapsedTitle: heading,
        // Each field keeps its own window, so two previews can be open at
        // the same time.
        key: `markdown-preview:${textarea.id || textarea.name}`,
        title: heading,
      },
      content,
    );
    modal.content.replaceChildren(copyFor("loading"));
    // A preview that cannot load says so in its window. The field keeps the
    // words the operator typed, so the failure costs nothing else.
    const showFailure = (): void => {
      modal.content.replaceChildren(copyFor("failed"));
    };
    try {
      const res = await fetch("/admin/markdown-preview", {
        body: new URLSearchParams({
          content: textarea.value,
          csrfToken: csrfTokenFor(textarea),
        }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      if (!res.ok) {
        showFailure();
        return;
      }
      const html = (await res.text()).trim();
      if (html === "") {
        modal.content.replaceChildren(copyFor("empty"));
        return;
      }
      modal.content.innerHTML = html;
    } catch {
      showFailure();
    }
  };

  for (const textarea of textareas) {
    // Capture the counter before inserting the footer, which would otherwise
    // become the textarea's next sibling.
    const counter = counterAfter(textarea);

    const footer = document.createElement("div");
    footer.className = "md-editor-footer";

    const link = copyFor("open");
    link.addEventListener("click", () => requestPreview(textarea));

    textarea.insertAdjacentElement("afterend", footer);
    footer.append(link);
    if (counter !== null) footer.append(counter);
  }
};
