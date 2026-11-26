import { defineAdminRoutes } from "#routes/admin/route-tables.ts";

/**
 * Admin site page editor routes - manage public site content.
 * Access: owner + editor (managers stay excluded — see SITE_ADMIN_LEVELS).
 */

import { logActivity } from "#db/activity-log.ts";
import { getAllListings } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import {
  settingsHandler,
  settingsToggle,
} from "#routes/admin/settings-helpers.ts";
import {
  type AuthSession,
  requireSiteOr,
  SITE_FORM,
  sitePage,
} from "#routes/auth.ts";
import { authFlashPage } from "#routes/auth-flash-page.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import { createAuthedFormRoute } from "#shared/app-forms.ts";
import { isBotpoisonEnabled } from "#shared/config.ts";
import {
  applyDemoOverrides,
  SITE_CONTACT_DEMO_FIELDS,
  SITE_HOME_DEMO_FIELDS,
} from "#shared/demo/overrides.ts";
import { readSubmittedMarkdown } from "#shared/forms/submitted-value.ts";
import { maxTextareaValidator } from "#shared/forms/textarea-limit.ts";
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
  authFlashPage(requireSiteOr, render);

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
    await settings.update.websiteTitle(values.websiteTitle);
    await settings.update.homepageText(values.homepageText);
    await logActivity("Homepage updated");
    return redirect("/admin/site", t("site.homepage_updated"), true);
  },
});

const siteTextPage = (
  page: string,
  field: string,
  label: string,
  log: string,
  save: (v: string) => Promise<void>,
) => ({ field, label, log, page, save });

/** The Site editor pages' own writes. Each page saves one Markdown text box,
 *  and the contact, order, and reviews pages each switch their public page on
 *  and off. Both writes return to the page's editor. */
const SITE_TEXT_PAGES = {
  contact: {
    ...siteTextPage(
      "/admin/site/contact",
      "contactPageText",
      "Contact page text",
      "Contact page updated",
      settings.update.contactPageText,
    ),
    demo: SITE_CONTACT_DEMO_FIELDS,
  },
  order: siteTextPage(
    "/admin/site/order",
    "orderIntroText",
    "Order intro",
    "Order page updated",
    settings.update.orderIntroText,
  ),
  reviews: siteTextPage(
    "/admin/site/reviews",
    "reviewsIntroText",
    "Reviews intro",
    "Reviews page updated",
    settings.update.reviewsIntroText,
  ),
} as const;

const siteTogglePage = (
  page: string,
  field: string,
  label: string,
  save: (v: boolean) => Promise<void>,
) => ({ field, label, page, save });

/** The Site editor pages' public-page switches. */
const SITE_TOGGLES = {
  contact: siteTogglePage(
    "/admin/site/contact",
    "contactFormEnabled",
    "Contact form",
    settings.update.contactFormEnabled,
  ),
  order: siteTogglePage(
    "/admin/site/order",
    "orderEnabled",
    "Order page",
    settings.update.orderEnabled,
  ),
  reviews: siteTogglePage(
    "/admin/site/reviews",
    "reviewsEnabled",
    "Reviews page",
    settings.update.reviewsEnabled,
  ),
} as const;

/** One Site editor page's Markdown text write. */
const siteTextHandler = (name: keyof typeof SITE_TEXT_PAGES): RequestRoute => {
  const config = SITE_TEXT_PAGES[name];
  return settingsHandler({
    auth: SITE_FORM,
    extract: (form) => {
      if ("demo" in config) applyDemoOverrides(form, config.demo);
      return readSubmittedMarkdown(form, config.field);
    },
    log: () => config.log,
    redirectTo: config.page,
    save: config.save,
    validate: maxTextareaValidator(MAX_TEXTAREA_LENGTH, config.label),
  });
};

/** One Site editor page's public-form switch write. */
const siteToggleHandler = (name: keyof typeof SITE_TOGGLES): RequestRoute => {
  const config = SITE_TOGGLES[name];
  return settingsToggle({
    auth: SITE_FORM,
    field: config.field,
    label: config.label,
    redirectTo: config.page,
    save: config.save,
  });
};

/** Handle POST /admin/site/contact - save contact page */
const handleSiteContactPost = siteTextHandler("contact");

/** Handle POST /admin/site/contact/form - toggle the public contact form */
const handleSiteContactFormTogglePost = siteToggleHandler("contact");

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
const handleSiteOrderTogglePost = siteToggleHandler("order");

/** Handle POST /admin/site/order - save the order page intro text */
const handleSiteOrderPost = siteTextHandler("order");

/** Handle POST /admin/site/reviews/toggle - enable/disable the public reviews page */
const handleSiteReviewsTogglePost = siteToggleHandler("reviews");

/** Handle POST /admin/site/reviews/intro - save the reviews page intro text */
const handleSiteReviewsPost = siteTextHandler("reviews");

/** Site editor routes */
export const adminHandlers = defineAdminRoutes({
  "GET /admin/site": siteGetRoute(renderHomePage),
  "GET /admin/site/contact": siteGetRoute(renderContactPage),
  "GET /admin/site/order": handleSiteOrderGet,
  "POST /admin/site": handleSiteHomePost,
  "POST /admin/site/contact": handleSiteContactPost,
  "POST /admin/site/contact/form": handleSiteContactFormTogglePost,
  "POST /admin/site/order": handleSiteOrderPost,
  "POST /admin/site/order/toggle": handleSiteOrderTogglePost,
  "POST /admin/site/reviews/intro": handleSiteReviewsPost,
  "POST /admin/site/reviews/toggle": handleSiteReviewsTogglePost,
});
