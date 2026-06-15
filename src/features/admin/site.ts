/**
 * Admin site page editor routes - manage public site content
 * Owner-only access
 */

import {
  settingsHandler,
  settingsToggle,
} from "#routes/admin/settings-helpers.ts";
import { type AuthSession, requireOwnerOr } from "#routes/auth.ts";
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
  adminSiteQuotePage,
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

export const siteQuoteForm = defineForm({
  fields: [
    {
      hintHtml: `Shown at the top of the public quote page (max ${MAX_TEXTAREA_LENGTH} characters). ${FORMATTING_HINT}`,
      id: "quote_intro_text",
      label: "Quote Page Intro",
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      name: "quote_intro_text",
      placeholder: "Pick the products you're interested in...",
      type: "textarea" as const,
    },
  ] as const,
  id: "siteQuote",
});

/** Count active, visible, purchase-only products eligible for the quote page. */
const countQuoteProducts = async (): Promise<number> => {
  const listings = await getAllListings();
  return listings.filter((e) => e.active && !e.hidden && e.purchase_only)
    .length;
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
  field: "contact_form_enabled",
  label: "Contact form",
  redirectTo: "/admin/site/contact",
  save: (v) => settings.update.contactFormEnabled(v),
});

/** Handle POST /admin/site/contact - save contact page */
const handleSiteContactPost = settingsHandler({
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

/** Handle GET /admin/site/quotes - quote page editor (owner only).
 * Loads the live product count so the editor can warn when there is nothing to
 * show, then renders the toggle + intro-text forms. */
const handleSiteQuoteGet = (request: Request): Promise<Response> =>
  requireOwnerOr(request, async (session) => {
    const flash = applyFlash(request);
    const productCount = await countQuoteProducts();
    return htmlResponse(
      adminSiteQuotePage(
        session,
        settings.quoteIntroText,
        { enabled: settings.quoteEnabled, productCount },
        flash.error,
        flash.success,
      ),
    );
  });

/** Handle POST /admin/site/quotes/toggle - enable/disable the public quote page */
const handleSiteQuoteTogglePost = settingsToggle({
  field: "quote_enabled",
  label: "Quote page",
  redirectTo: "/admin/site/quotes",
  save: (v) => settings.update.quoteEnabled(v),
});

/** Handle POST /admin/site/quotes - save the quote page intro text */
const handleSiteQuotePost = settingsHandler({
  extract: (form) => form.getString("quote_intro_text"),
  label: "Quote page",
  log: () => "Quote page updated",
  redirectTo: "/admin/site/quotes",
  save: (v) => settings.update.quoteIntroText(v),
  validate: (v) =>
    v.length > MAX_TEXTAREA_LENGTH
      ? `Quote intro must be ${MAX_TEXTAREA_LENGTH} characters or fewer (currently ${v.length})`
      : null,
});

/** Site editor routes */
export const siteRoutes = defineRoutes({
  "GET /admin/site": siteGetRoute(renderHomePage),
  "GET /admin/site/contact": siteGetRoute(renderContactPage),
  "GET /admin/site/quotes": handleSiteQuoteGet,
  "POST /admin/site": handleSiteHomePost,
  "POST /admin/site/contact": handleSiteContactPost,
  "POST /admin/site/contact/form": handleSiteContactFormTogglePost,
  "POST /admin/site/quotes": handleSiteQuotePost,
  "POST /admin/site/quotes/toggle": handleSiteQuoteTogglePost,
});
