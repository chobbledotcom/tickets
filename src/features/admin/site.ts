import { defineRoutes } from "#routes/router.ts";

/**
 * Admin site page editor routes - manage public site content.
 * Access: owner + editor (managers stay excluded — see SITE_ADMIN_LEVELS).
 */

import { logActivity } from "#db/activity-log.ts";
import { getAllListings } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import {
  settingsHandler,
  settingsToggle,
} from "#routes/admin/settings-helpers.ts";
import { type AuthSession, SITE_FORM, sitePage } from "#routes/auth.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import { createAuthedFormRoute } from "#shared/app-forms.ts";
import { isBotpoisonEnabled } from "#shared/config.ts";
import {
  applyDemoOverrides,
  SITE_CONTACT_DEMO_FIELDS,
  SITE_HOME_DEMO_FIELDS,
} from "#shared/demo/overrides.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { isPublicListing } from "#shared/listing-visibility.ts";
import type { RequestRoute } from "#shared/response-steps.ts";
import {
  adminSiteContactPage,
  adminSiteHomePage,
  adminSiteOrderPage,
} from "#templates/admin/site.tsx";
import { siteHomeForm } from "#templates/fields/site.ts";

/** Count active, visible listings — every one appears on the order page. */
const countOrderListings = async (): Promise<number> => {
  const listings = await getAllListings();
  return listings.filter(isPublicListing).length;
};

type PageRenderer = (
  session: AuthSession,
  error?: string,
  success?: string,
) => string;

/** Site-editing GET route that renders a site editor page */
const siteGetRoute = (render: PageRenderer): RequestRoute =>
  sitePage((session, _request, flash) =>
    render(session, flash.error, flash.success),
  );

/** Render homepage editor with current state */
const renderHomePage: PageRenderer = (session, error, success) =>
  adminSiteHomePage(
    session,
    settings.websiteTitle,
    settings.homepageText,
    error,
    success,
  );

/** Render contact editor with current state */
const renderContactPage: PageRenderer = (session, error, success) =>
  adminSiteContactPage(
    session,
    settings.contactPageText,
    {
      botpoisonEnabled: isBotpoisonEnabled(),
      enabled: settings.contactFormEnabled,
      hasBusinessEmail: settings.businessEmail !== "",
    },
    error,
    success,
  );

/** Handle POST /admin/site - save homepage */
const handleSiteHomePost = createAuthedFormRoute({
  auth: SITE_FORM,
  form: {
    validate: (form) => {
      applyDemoOverrides(form, SITE_HOME_DEMO_FIELDS);
      return siteHomeForm.validate(form);
    },
  },
  onInvalid: ({ error }) => errorRedirect("/admin/site", error),
  onValid: async ({ values }) => {
    await settings.update.websiteTitle(values.website_title);
    await settings.update.homepageText(values.homepage_text);
    await logActivity("Homepage updated");
    return redirect("/admin/site", "Homepage updated", true);
  },
});

/** Handle POST /admin/site/contact/form - toggle the public contact form */
const handleSiteContactFormTogglePost = settingsToggle({
  auth: SITE_FORM,
  field: "contact_form_enabled",
  label: "Contact form",
  redirectTo: "/admin/site/contact",
  save: (v) => settings.update.contactFormEnabled(v),
});

/** Handle POST /admin/site/contact - save contact page */
const handleSiteContactPost = settingsHandler({
  auth: SITE_FORM,
  extract: (form) => {
    applyDemoOverrides(form, SITE_CONTACT_DEMO_FIELDS);
    return form.getString("contact_page_text");
  },
  log: () => "Contact page updated",
  redirectTo: "/admin/site/contact",
  save: (v) => settings.update.contactPageText(v),
  validate: (v) =>
    v.length > MAX_TEXTAREA_LENGTH
      ? `Contact page text must be ${MAX_TEXTAREA_LENGTH} characters or fewer (currently ${v.length})`
      : null,
});

/** Handle GET /admin/site/order - order page editor (owner only).
 * Loads the live listing count so the editor can warn when there is nothing to
 * show, then renders the toggle + intro-text forms. */
const handleSiteOrderGet = sitePage(async (session, _request, flash) => {
  const listingCount = await countOrderListings();
  return adminSiteOrderPage(
    session,
    settings.orderIntroText,
    { enabled: settings.orderEnabled, listingCount },
    flash.error,
    flash.success,
  );
});

/** Handle POST /admin/site/order/toggle - enable/disable the public order page */
const handleSiteOrderTogglePost = settingsToggle({
  auth: SITE_FORM,
  field: "order_enabled",
  label: "Order page",
  redirectTo: "/admin/site/order",
  save: (v) => settings.update.orderEnabled(v),
});

/** Handle POST /admin/site/order - save the order page intro text */
const handleSiteOrderPost = settingsHandler({
  auth: SITE_FORM,
  extract: (form) => form.getString("order_intro_text"),
  log: () => "Order page updated",
  redirectTo: "/admin/site/order",
  save: (v) => settings.update.orderIntroText(v),
  validate: (v) =>
    v.length > MAX_TEXTAREA_LENGTH
      ? `Order intro must be ${MAX_TEXTAREA_LENGTH} characters or fewer (currently ${v.length})`
      : null,
});

/** Site editor routes */
export const adminHandlers = defineRoutes({
  "GET /admin/site": siteGetRoute(renderHomePage),
  "GET /admin/site/contact": siteGetRoute(renderContactPage),
  "GET /admin/site/order": handleSiteOrderGet,
  "POST /admin/site": handleSiteHomePost,
  "POST /admin/site/contact": handleSiteContactPost,
  "POST /admin/site/contact/form": handleSiteContactFormTogglePost,
  "POST /admin/site/order": handleSiteOrderPost,
  "POST /admin/site/order/toggle": handleSiteOrderTogglePost,
});
