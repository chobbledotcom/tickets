/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Markdown preview: adds a "Preview" link under each markdown editor (opposite
 * the character counter) that renders the current content via the admin-only
 * /admin/markdown-preview endpoint and shows it in a modal dialog.
 *
 * Rendering happens server-side so the preview matches the public page exactly
 * and is sanitised (raw HTML escaped, unsafe URLs stripped) before it reaches
 * the DOM. The request carries the page's CSRF token so it can't be triggered
 * cross-site.
 */

import { ICONS_PATH } from "#shared/asset-paths.ts";

/** Lazily-built shared dialog, reused by every editor on the page. */
type PreviewDialog = {
  open: () => void;
  setLoading: () => void;
  show: (html: string) => void;
};

const createDialog = (): PreviewDialog => {
  const dialog = document.createElement("dialog");
  dialog.className = "md-preview-dialog";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "md-preview-close";
  close.setAttribute("aria-label", "Close preview");
  close.innerHTML = `<svg class="icon" aria-hidden="true" focusable="false"><use href="${ICONS_PATH}#x"></use></svg>`;
  close.addEventListener("click", () => dialog.close());

  const content = document.createElement("div");
  content.className = "md-preview-content prose";

  dialog.append(close, content);
  // Close when the backdrop (the dialog element itself) is clicked.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.body.appendChild(dialog);

  return {
    open: () => dialog.showModal(),
    setLoading: () => {
      content.textContent = "Loading preview…";
    },
    show: (html) => {
      content.innerHTML = html.trim() || "<p><em>Nothing to preview.</em></p>";
    },
  };
};

/** Find the CSRF token for the form a textarea belongs to. */
const csrfTokenFor = (textarea: HTMLTextAreaElement): string =>
  textarea
    .closest("form")
    ?.querySelector<HTMLInputElement>('input[name="csrf_token"]')?.value ?? "";

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

  let dialog: PreviewDialog | null = null;

  const requestPreview = async (
    textarea: HTMLTextAreaElement,
  ): Promise<void> => {
    const d = (dialog ??= createDialog());
    d.setLoading();
    d.open();
    try {
      const res = await fetch("/admin/markdown-preview", {
        body: new URLSearchParams({
          content: textarea.value,
          csrf_token: csrfTokenFor(textarea),
        }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      d.show(res.ok ? await res.text() : "<p><em>Preview failed.</em></p>");
    } catch {
      d.show("<p><em>Preview failed.</em></p>");
    }
  };

  for (const textarea of textareas) {
    // Capture the counter before inserting the footer, which would otherwise
    // become the textarea's next sibling.
    const counter = counterAfter(textarea);

    const footer = document.createElement("div");
    footer.className = "md-editor-footer";

    const link = document.createElement("button");
    link.type = "button";
    link.className = "md-preview-link";
    link.textContent = "Preview";
    link.addEventListener("click", () => requestPreview(textarea));

    textarea.insertAdjacentElement("afterend", footer);
    footer.appendChild(link);
    if (counter) footer.appendChild(counter);
  }
};
