/**
 * The markdown preview's shared facts: the id of the `<template>` that holds
 * its markup and copy, and the names of the copy it clones. The admin shell
 * renders the template on every admin page. The client module in
 * `src/ui/client/admin/markdown-preview.ts` adds the behaviour.
 */

/** The id of the inert `<template>` that carries the preview's link and the
 *  words its window shows. */
export const MARKDOWN_PREVIEW_TEMPLATE_ID = "markdown-preview";

/** The notes the preview shows in place of the rendered text, by the
 *  `data-copy` name the template uses. */
export const PREVIEW_NOTES = ["empty", "failed", "loading"] as const;

export type PreviewNote = (typeof PREVIEW_NOTES)[number];

/** The copy the preview clones from its template. */
export type PreviewCopy = PreviewNote | "open" | "title";
