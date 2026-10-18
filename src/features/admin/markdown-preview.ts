import { defineRoutes } from "#routes/router.ts";
/**
 * Markdown preview endpoint.
 *
 * POST /admin/markdown-preview renders a markdown body to safe HTML for the
 * in-editor preview dialog. Content roles (owner/manager/editor) can open it,
 * because editors edit markdown fields on listings and the site pages. The
 * withAuth form gate adds CSRF protection, so the rendered fragment cannot be
 * triggered cross-site. The renderMarkdown call strips raw HTML and unsafe
 * URLs. The returned fragment is safe to inject client-side. It renders only
 * the supplied content — no stored data — so widening the role leaks nothing.
 */

import { addPageImageUrls } from "#db/images.ts";
import { CONTENT_FORM, withAuth } from "#routes/auth.ts";
import { htmlResponse } from "#routes/response.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { renderMarkdown } from "#shared/markdown.ts";

const handleMarkdownPreviewPost = (request: Request): Promise<Response> =>
  withAuth(request, CONTENT_FORM, async (_session, form) => {
    const content = form.getString("content");
    if (content.length > MAX_TEXTAREA_LENGTH) {
      return htmlResponse("Content too long", 413);
    }
    // The lookup fills the request's page-image slot first, so an img#N
    // reference in the buffer renders the image's URL.
    await addPageImageUrls([content]);
    return htmlResponse(renderMarkdown(content));
  });

export const adminHandlers = defineRoutes({
  "POST /admin/markdown-preview": handleMarkdownPreviewPost,
});
