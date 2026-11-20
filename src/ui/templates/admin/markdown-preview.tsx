/**
 * The markdown preview's inert markup and copy, rendered once on each admin
 * page as a `<template>`. The client module in
 * `src/ui/client/admin/markdown-preview.ts` clones the link for each markdown
 * field and the notes for each state of the preview window.
 */

import { t } from "#i18n";
import {
  MARKDOWN_PREVIEW_TEMPLATE_ID,
  PREVIEW_NOTES,
} from "#shared/markdown-preview.ts";

export const MarkdownPreviewTemplate = (): JSX.Element => (
  <template id={MARKDOWN_PREVIEW_TEMPLATE_ID}>
    <button class="md-preview-link" data-copy="open" type="button">
      {t("modal.preview.open")}
    </button>
    <span data-copy="title">{t("modal.preview.heading")}</span>
    {PREVIEW_NOTES.map((note) => (
      <p data-copy={note}>
        <em>{t(`modal.preview.${note}`)}</em>
      </p>
    ))}
  </template>
);
