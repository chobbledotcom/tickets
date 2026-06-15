/**
 * Markdown preview endpoint.
 *
 * POST /admin/markdown-preview — renders a markdown body to safe HTML for the
 * in-editor preview dialog. Any authenticated admin may use it; the request is
 * CSRF-protected (form body, validated by withAuth) so the rendered fragment
 * can't be triggered cross-site. Raw HTML and unsafe URLs are stripped by
 * renderMarkdown, so the returned fragment is safe to inject client-side.
 */

import { AUTH_FORM, withAuth } from "#routes/auth.ts";
import { htmlResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { renderMarkdown } from "#shared/markdown.ts";

/** Handle POST /admin/markdown-preview — render markdown body to safe HTML. */
const handleMarkdownPreviewPost = (request: Request): Promise<Response> =>
  withAuth(request, AUTH_FORM, (_session, form) => {
    const content = form.getString("content");
    if (content.length > MAX_TEXTAREA_LENGTH) {
      return htmlResponse("Content too long", 413);
    }
    return htmlResponse(renderMarkdown(content));
  });

/** Markdown preview routes */
export const markdownPreviewRoutes = defineRoutes({
  "POST /admin/markdown-preview": handleMarkdownPreviewPost,
});
