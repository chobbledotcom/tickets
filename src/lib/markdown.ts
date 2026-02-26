/**
 * Markdown rendering for user-authored content.
 * Uses marked with raw HTML disabled for safety.
 */

import { Marked } from "marked";

const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const md = new Marked({
  breaks: true,
  renderer: {
    html({ raw }) {
      return escapeHtml(raw);
    },
  },
});

/** Render markdown to HTML (block-level: paragraphs, lists, etc.). Raw HTML is escaped. */
export const renderMarkdown = (text: string): string =>
  md.parse(text) as string;

/** Render markdown to inline HTML (no wrapping <p> tags). Raw HTML is escaped. */
export const renderMarkdownInline = (text: string): string =>
  md.parseInline(text) as string;
