/**
 * Markdown rendering for user-authored content.
 * Uses marked with raw HTML disabled for safety.
 */

import { Marked } from "marked";
import { escapeHtml } from "#templates/layout.tsx";

const md = new Marked({
  renderer: {
    html({ raw }) {
      return escapeHtml(raw);
    },
  },
});

/** Render markdown to HTML (block-level: paragraphs, lists, etc.). Raw HTML is escaped. */
export const renderMarkdown = (text: string): string =>
  md.parse(text) as string;
