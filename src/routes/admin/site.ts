/**
 * Admin site page editor routes - manage public site content
 * Owner-only access
 */

import { logActivity } from "#lib/db/activityLog.ts";
import { MAX_WEBSITE_TITLE_LENGTH, settings } from "#lib/db/settings.ts";
import {
  applyDemoOverrides,
  SITE_CONTACT_DEMO_FIELDS,
  SITE_HOME_DEMO_FIELDS,
} from "#lib/demo.ts";
import type { FormParams } from "#lib/form-data.ts";
import { MAX_TEXTAREA_LENGTH } from "#lib/limits.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  applyFlash,
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

/** Owner-only GET route that renders a site editor page */
const siteGetRoute =
  (render: PageRenderer) =>
  (request: Request): Promise<Response> =>
    requireOwnerOr(request, (session) => {
      const flash = applyFlash(request);
      const html = render(session, flash.error, flash.success);
      return htmlResponse(html);
    });

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
const handleSiteHomePost = sitePostRoute(async (_session, form) => {
  applyDemoOverrides(form, SITE_HOME_DEMO_FIELDS);

  const titleRaw = form.getString("website_title");
  if (titleRaw.length > MAX_WEBSITE_TITLE_LENGTH) {
    return errorRedirect(
      "/admin/site",
      `Website title must be ${MAX_WEBSITE_TITLE_LENGTH} characters or fewer (currently ${titleRaw.length})`,
    );
  }

  const textRaw = form.getString("homepage_text");
  if (textRaw.length > MAX_TEXTAREA_LENGTH) {
    return errorRedirect(
      "/admin/site",
      `Homepage text must be ${MAX_TEXTAREA_LENGTH} characters or fewer (currently ${textRaw.length})`,
    );
  }

  await settings.update.websiteTitle(titleRaw);
  await settings.update.homepageText(textRaw);
  await logActivity("Site homepage updated");
  return redirect("/admin/site", "Homepage updated", true);
});

/** Handle POST /admin/site/contact - save contact page */
const handleSiteContactPost = sitePostRoute(async (_session, form) => {
  applyDemoOverrides(form, SITE_CONTACT_DEMO_FIELDS);
  const textRaw = form.getString("contact_page_text");
  if (textRaw.length > MAX_TEXTAREA_LENGTH) {
    return errorRedirect(
      "/admin/site/contact",
      `Contact page text must be ${MAX_TEXTAREA_LENGTH} characters or fewer (currently ${textRaw.length})`,
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
