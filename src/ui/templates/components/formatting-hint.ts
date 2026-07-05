import { t } from "#i18n";

/** Shared formatting hint linking to the standalone markdown help page. */
export const formattingHint = (): string =>
  `<a href="/admin/formatting" target="_blank" rel="noopener">${t(
    "common.formatting_help",
  )}</a>`;
