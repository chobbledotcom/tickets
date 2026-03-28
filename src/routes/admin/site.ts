/**
 * Admin site page editor routes - manage public site content
 * Owner-only access
 */

import { MAX_WEBSITE_TITLE_LENGTH, settings } from "#lib/db/settings.ts";
import {
  applyDemoOverrides,
  SITE_CONTACT_DEMO_FIELDS,
  SITE_HOME_DEMO_FIELDS,
} from "#lib/demo.ts";
import { MAX_TEXTAREA_LENGTH } from "#lib/limits.ts";
import { settingsHandler } from "#routes/admin/settings-helpers.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  type AuthSession,
  applyFlash,
  htmlResponse,
  requireOwnerOr,
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
const handleSiteHomePost = settingsHandler<{ title: string; text: string }>({
  label: "Site homepage",
  redirectTo: "/admin/site",
  extract: (form) => {
    applyDemoOverrides(form, SITE_HOME_DEMO_FIELDS);
    return { title: form.getString("website_title"), text: form.getString("homepage_text") };
  },
  validate: ({ title, text }) => {
    if (title.length > MAX_WEBSITE_TITLE_LENGTH) {
      return `Website title must be ${MAX_WEBSITE_TITLE_LENGTH} characters or fewer (currently ${title.length})`;
    }
    if (text.length > MAX_TEXTAREA_LENGTH) {
      return `Homepage text must be ${MAX_TEXTAREA_LENGTH} characters or fewer (currently ${text.length})`;
    }
    return null;
  },
  save: async ({ title, text }) => {
    await settings.update.websiteTitle(title);
    await settings.update.homepageText(text);
  },
  message: () => "Homepage updated",
});

/** Handle POST /admin/site/contact - save contact page */
const handleSiteContactPost = settingsHandler({
  label: "Site contact page",
  redirectTo: "/admin/site/contact",
  extract: (form) => {
    applyDemoOverrides(form, SITE_CONTACT_DEMO_FIELDS);
    return form.getString("contact_page_text");
  },
  validate: (v) =>
    v.length > MAX_TEXTAREA_LENGTH
      ? `Contact page text must be ${MAX_TEXTAREA_LENGTH} characters or fewer (currently ${v.length})`
      : null,
  save: (v) => settings.update.contactPageText(v),
  message: () => "Contact page updated",
});

/** Site editor routes */
export const siteRoutes = defineRoutes({
  "GET /admin/site": siteGetRoute(renderHomePage),
  "POST /admin/site": handleSiteHomePost,
  "GET /admin/site/contact": siteGetRoute(renderContactPage),
  "POST /admin/site/contact": handleSiteContactPost,
});
