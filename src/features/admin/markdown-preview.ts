import { defineAdminRoutes } from "#routes/admin/route-tables.ts";

/**
 * Markdown preview endpoint.
 *
 * POST /admin/markdown-preview renders a markdown body to safe HTML for the
 * preview dialog. Content roles (owner/manager/editor) can open it, because
 * editors edit markdown fields on listings and site pages. The withAuth form
 * gate adds CSRF protection, so the rendered fragment cannot be triggered
 * cross-site. The renderMarkdown call strips raw HTML and unsafe URLs, so the
 * fragment is safe to inject. The only stored data the handler reads is the
 * public URL of an image whose id the supplied content names. No other stored
 * data is read or returned, so a wider role leaks only those URLs.
 */

import { addPageImageUrls } from "#db/image-urls.ts";
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

export const adminHandlers = defineAdminRoutes({
  "POST /admin/markdown-preview": handleMarkdownPreviewPost,
});
