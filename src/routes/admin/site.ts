/**
 * Admin site page editor routes - manage public site content
 * Owner-only access
 */

import { logActivity } from "#lib/db/activityLog.ts";
import {
  MAX_PAGE_TEXT_LENGTH,
  MAX_WEBSITE_TITLE_LENGTH,
  settings,
} from "#lib/db/settings.ts";
import {
  applyDemoOverrides,
  SITE_CONTACT_DEMO_FIELDS,
  SITE_HOME_DEMO_FIELDS,
} from "#lib/demo.ts";
import { getFlash } from "#lib/flash-context.ts";
import type { FormParams } from "#lib/form-data.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  type AuthSession,
  htmlResponse,
  redirect,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";
import {
  adminSiteContactPage,
  adminSiteHomePage,
} from "#templates/admin/site.tsx";

type PageRenderer = (
  session: AuthSession,
  error?: string,
  success?: string,
) => string;

/** Build error page callback for a given renderer */
const errorPageFor =
  (session: AuthSession, render: PageRenderer) =>
  (error: string, status: number): Response =>
    htmlResponse(render(session, error), status);

/** Owner-only GET route that renders a site editor page */
const siteGetRoute =
  (render: PageRenderer) =>
  (request: Request): Promise<Response> => {
    const flash = getFlash();
    return requireOwnerOr(request, (session) => {
      const html = render(session, flash.error, flash.success);
      return htmlResponse(html);
    });
  };

type SitePostHandler = (
  session: AuthSession,
  form: FormParams,
) => Promise<Response>;

/** Owner-only POST route for site editor forms */
const sitePostRoute =
  (handler: SitePostHandler) =>
  (request: Request): Promise<Response> =>
    withOwnerAuthForm(request, handler);

/** Render homepage editor with current state */
const renderHomePage: PageRenderer = (session, error, success) => {
  return adminSiteHomePage(
    session,
    settings.websiteTitle,
    settings.homepageText,
    error,
    success,
  );
};

/** Render contact editor with current state */
const renderContactPage: PageRenderer = (session, error, success) => {
  return adminSiteContactPage(
    session,
    settings.contactPageText,
    error,
    success,
  );
};

/** Handle POST /admin/site - save homepage */
const handleSiteHomePost = sitePostRoute(async (session, form) => {
  applyDemoOverrides(form, SITE_HOME_DEMO_FIELDS);
  const showError = errorPageFor(session, renderHomePage);

  const titleRaw = form.getString("website_title");
  if (titleRaw.length > MAX_WEBSITE_TITLE_LENGTH) {
    return showError(
      `Website title must be ${MAX_WEBSITE_TITLE_LENGTH} characters or fewer (currently ${titleRaw.length})`,
      400,
    );
  }

  const textRaw = form.getString("homepage_text");
  if (textRaw.length > MAX_PAGE_TEXT_LENGTH) {
    return showError(
      `Homepage text must be ${MAX_PAGE_TEXT_LENGTH} characters or fewer (currently ${textRaw.length})`,
      400,
    );
  }

  await settings.update.websiteTitle(titleRaw);
  await settings.update.homepageText(textRaw);
  await logActivity("Site homepage updated");
  return redirect("/admin/site", "Homepage updated", true);
});

/** Handle POST /admin/site/contact - save contact page */
const handleSiteContactPost = sitePostRoute(async (session, form) => {
  applyDemoOverrides(form, SITE_CONTACT_DEMO_FIELDS);
  const textRaw = form.getString("contact_page_text");
  if (textRaw.length > MAX_PAGE_TEXT_LENGTH) {
    return errorPageFor(session, renderContactPage)(
      `Contact page text must be ${MAX_PAGE_TEXT_LENGTH} characters or fewer (currently ${textRaw.length})`,
      400,
    );
  }

  await settings.update.contactPageText(textRaw);
  await logActivity("Site contact page updated");
  return redirect("/admin/site/contact", "Contact page updated", true);
});

/** Site editor routes */
export const siteRoutes = defineRoutes({
  "GET /admin/site": siteGetRoute(renderHomePage),
  "POST /admin/site": handleSiteHomePost,
  "GET /admin/site/contact": siteGetRoute(renderContactPage),
  "POST /admin/site/contact": handleSiteContactPost,
});
