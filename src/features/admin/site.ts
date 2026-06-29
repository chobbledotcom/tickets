/**
 * Admin site page editor routes - manage public site content.
 * Access: owner + editor (managers stay excluded — see SITE_ADMIN_LEVELS).
 */

import {
  settingsHandler,
  settingsToggle,
} from "#routes/admin/settings-helpers.ts";
import { type AuthSession, requireSiteOr, SITE_FORM } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { isBotpoisonEnabled } from "#shared/config.ts";
import { getAllListings } from "#shared/db/listings.ts";
import { MAX_WEBSITE_TITLE_LENGTH, settings } from "#shared/db/settings.ts";
import {
  applyDemoOverrides,
  SITE_CONTACT_DEMO_FIELDS,
  SITE_HOME_DEMO_FIELDS,
} from "#shared/demo.ts";
import { defineForm } from "#shared/forms.tsx";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  adminSiteContactPage,
  adminSiteHomePage,
  adminSiteOrderPage,
} from "#templates/admin/site.tsx";
import { FORMATTING_HINT } from "#templates/fields.ts";

export const siteHomeForm = defineForm({
  fields: [
    {
      autocomplete: "off" as const,
      hint: "Displayed as the main heading on all public pages (max 128 characters).",
      id: "website_title",
      label: "Website Title",
      maxlength: MAX_WEBSITE_TITLE_LENGTH,
      name: "website_title",
      type: "text" as const,
    },
    {
      hintHtml: `Text displayed on the public homepage (max ${MAX_TEXTAREA_LENGTH} characters). ${FORMATTING_HINT}`,
      id: "homepage_text",
      label: "Homepage Text",
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      name: "homepage_text",
      placeholder: "Welcome to our site...",
      type: "textarea" as const,
    },
  ] as const,
  id: "siteHome",
});

export const siteContactForm = defineForm({
  fields: [
    {
      hintHtml: `Text displayed on the public contact page (max ${MAX_TEXTAREA_LENGTH} characters). ${FORMATTING_HINT}`,
      id: "contact_page_text",
      label: "Contact Page Text",
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      name: "contact_page_text",
      placeholder: "Get in touch with us...",
      type: "textarea" as const,
    },
  ] as const,
  id: "siteContact",
});

export const siteOrderForm = defineForm({
  fields: [
    {
      hintHtml: `Shown at the top of the public order page (max ${MAX_TEXTAREA_LENGTH} characters). ${FORMATTING_HINT}`,
      id: "order_intro_text",
      label: "Order Page Intro",
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      name: "order_intro_text",
      placeholder: "Pick the items you're interested in...",
      type: "textarea" as const,
    },
  ] as const,
  id: "siteOrder",
});

/** Count active, visible listings — every one appears on the order page. */
const countOrderListings = async (): Promise<number> => {
  const listings = await getAllListings();
  return listings.filter((e) => e.active && !e.hidden).length;
};

type PageRenderer = (
  session: AuthSession,
  error?: string,
  success?: string,
) => string;

/** Owner-only GET route that renders a site editor page */
const siteGetRoute =
  (render: PageRenderer) =>
  (request: Request): Promise<Response> =>
    requireSiteOr(request, (session) => {
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
    {
      botpoisonEnabled: isBotpoisonEnabled(),
      enabled: settings.contactFormEnabled,
      hasBusinessEmail: settings.businessEmail !== "",
    },
    error,
    success,
  );
};

/** Handle POST /admin/site - save homepage */
const handleSiteHomePost = settingsHandler<{ title: string; text: string }>({
  auth: SITE_FORM,
  extract: (form) => {
    applyDemoOverrides(form, SITE_HOME_DEMO_FIELDS);
    return {
      text: form.getString("homepage_text"),
      title: form.getString("website_title"),
    };
  },
  label: "Site homepage",
  log: () => "Homepage updated",
  redirectTo: "/admin/site",
  save: async ({ title, text }) => {
    await settings.update.websiteTitle(title);
    await settings.update.homepageText(text);
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
  label: "Site contact page",
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
const handleSiteOrderGet = (request: Request): Promise<Response> =>
  requireSiteOr(request, async (session) => {
    const flash = applyFlash(request);
    const listingCount = await countOrderListings();
    return htmlResponse(
      adminSiteOrderPage(
        session,
        settings.orderIntroText,
        { enabled: settings.orderEnabled, listingCount },
        flash.error,
        flash.success,
      ),
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
  label: "Order page",
  log: () => "Order page updated",
  redirectTo: "/admin/site/order",
  save: (v) => settings.update.orderIntroText(v),
  validate: (v) =>
    v.length > MAX_TEXTAREA_LENGTH
      ? `Order intro must be ${MAX_TEXTAREA_LENGTH} characters or fewer (currently ${v.length})`
      : null,
});

/** Site editor routes */
export const siteRoutes = defineRoutes({
  "GET /admin/site": siteGetRoute(renderHomePage),
  "GET /admin/site/contact": siteGetRoute(renderContactPage),
  "GET /admin/site/order": handleSiteOrderGet,
  "POST /admin/site": handleSiteHomePost,
  "POST /admin/site/contact": handleSiteContactPost,
  "POST /admin/site/contact/form": handleSiteContactFormTogglePost,
  "POST /admin/site/order": handleSiteOrderPost,
  "POST /admin/site/order/toggle": handleSiteOrderTogglePost,
});
