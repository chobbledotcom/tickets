/**
 * Admin site page editor routes - manage public site content
 * Owner-only access
 */

import { logActivity } from "#lib/db/activityLog.ts";
import {
  getContactPageTextFromDb,
  getHomepageTextFromDb,
  getWebsiteTitleFromDb,
  MAX_PAGE_TEXT_LENGTH,
  MAX_WEBSITE_TITLE_LENGTH,
  updateContactPageText,
  updateHomepageText,
  updateWebsiteTitle,
} from "#lib/db/settings.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  type AuthSession,
  getSearchParam,
  htmlResponse,
  redirectWithSuccess,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";
import { adminSiteContactPage, adminSiteHomePage } from "#templates/admin/site.tsx";

type PageRenderer = (session: AuthSession, error: string, success: string) => Promise<string>;

/** Build error page callback for a given renderer */
const errorPageFor = (session: AuthSession, render: PageRenderer) =>
  async (error: string, status: number): Promise<Response> =>
    htmlResponse(await render(session, error, ""), status);

/** Owner-only GET route that renders a site editor page */
const siteGetRoute = (render: PageRenderer) =>
  (request: Request): Promise<Response> => {
    const success = getSearchParam(request, "success");
    return requireOwnerOr(request, async (session) => {
      const html = await render(session, "", success);
      return htmlResponse(html);
    });
  };

type SitePostHandler = (session: AuthSession, form: URLSearchParams) => Promise<Response>;

/** Owner-only POST route for site editor forms */
const sitePostRoute = (handler: SitePostHandler) =>
  (request: Request): Promise<Response> =>
    withOwnerAuthForm(request, handler);

/** Render homepage editor with current state */
const renderHomePage: PageRenderer = async (session, error, success) => {
  const [websiteTitle, homepageText] = await Promise.all([
    getWebsiteTitleFromDb(),
    getHomepageTextFromDb(),
  ]);
  return adminSiteHomePage(session, websiteTitle, homepageText, error, success);
};

/** Render contact editor with current state */
const renderContactPage: PageRenderer = async (session, error, success) => {
  const contactText = await getContactPageTextFromDb();
  return adminSiteContactPage(session, contactText, error, success);
};

/** Handle POST /admin/site - save homepage */
const handleSiteHomePost = sitePostRoute(async (session, form) => {
  const showError = errorPageFor(session, renderHomePage);

  const titleRaw = (form.get("website_title") ?? "").trim();
  if (titleRaw.length > MAX_WEBSITE_TITLE_LENGTH) {
    return showError(
      `Website title must be ${MAX_WEBSITE_TITLE_LENGTH} characters or fewer (currently ${titleRaw.length})`,
      400,
    );
  }

  const textRaw = (form.get("homepage_text") ?? "").trim();
  if (textRaw.length > MAX_PAGE_TEXT_LENGTH) {
    return showError(
      `Homepage text must be ${MAX_PAGE_TEXT_LENGTH} characters or fewer (currently ${textRaw.length})`,
      400,
    );
  }

  await updateWebsiteTitle(titleRaw);
  await updateHomepageText(textRaw);
  await logActivity("Site homepage updated");
  return redirectWithSuccess("/admin/site", "Homepage updated");
});

/** Handle POST /admin/site/contact - save contact page */
const handleSiteContactPost = sitePostRoute(async (session, form) => {
  const textRaw = (form.get("contact_page_text") ?? "").trim();
  if (textRaw.length > MAX_PAGE_TEXT_LENGTH) {
    return errorPageFor(session, renderContactPage)(
      `Contact page text must be ${MAX_PAGE_TEXT_LENGTH} characters or fewer (currently ${textRaw.length})`,
      400,
    );
  }

  await updateContactPageText(textRaw);
  await logActivity("Site contact page updated");
  return redirectWithSuccess("/admin/site/contact", "Contact page updated");
});

/** Site editor routes */
export const siteRoutes = defineRoutes({
  "GET /admin/site": siteGetRoute(renderHomePage),
  "POST /admin/site": handleSiteHomePost,
  "GET /admin/site/contact": siteGetRoute(renderContactPage),
  "POST /admin/site/contact": handleSiteContactPost,
});
