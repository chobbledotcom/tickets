import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "postMarkdownPreview",
    "markdownPreview",
    "POST",
    "/admin/markdown-preview",
  ),
] as const;
