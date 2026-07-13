/**
 * Admin site page editor templates
 */

import { t } from "#i18n";
import {
  siteContactForm,
  siteHomeForm,
  siteOrderForm,
} from "#routes/admin/site.ts";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminLevel, AdminSession } from "#shared/types.ts";
import { flashAdminPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { ErrorNote } from "#templates/components/error.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";

/** The public-site guide footer shared by the home, contact and order editors
 * (all three map to the guide's `#public-site` section). The site editors are
 * owner+editor, but `/admin/guide` is staff-only, so it's role-gated: editors
 * see no footer rather than a link that 403s. */
const SiteGuideFooter = ({
  adminLevel,
}: {
  adminLevel: AdminLevel;
}): JSX.Element => (
  <GuideFooter adminLevel={adminLevel} href="/admin/guide#public-site">
    {t("site.guide_link")}
  </GuideFooter>
);

/** Open a site editor page: pass the title and nav path, then the session and
 * any flash messages, then the page body. The public-site guide footer is
 * always appended after the body. */
const siteEditorPage =
  (title: string, active: string) =>
  (session: AdminSession, error?: string, success?: string) =>
  (body: Child): string =>
    flashAdminPage(title, active)(session, error, success)(
      <>
        {body}
        <SiteGuideFooter adminLevel={session.adminLevel} />
      </>,
    );

/** Bind a site editor page to its title, nav path, and a body built from the
 *  page's two stored values, giving back a `(session, a, b, error?, success?)
 *  => string` page. The three site editors differ only in their title/path and
 *  how they render their values — never in this wrapper. */
const siteDataPage =
  <A, B>(title: string, active: string, renderBody: (a: A, b: B) => Child) =>
  (
    session: AdminSession,
    a: A,
    b: B,
    error?: string,
    success?: string,
  ): string =>
    siteEditorPage(title, active)(session, error, success)(renderBody(a, b));

/** One of the site text editors: its schema-rendered fields inside a form that
 * ends with the standard save button. */
const SiteTextForm = ({
  action,
  html,
}: {
  action: string;
  html: string;
}): JSX.Element => (
  <SaveForm action={action} submitLabel={t("common.save")}>
    <Raw html={html} />
  </SaveForm>
);

/**
 * Homepage editor - website title + homepage text
 */
export const adminSiteHomePage = siteDataPage<string, string>(
  t("site.home_title"),
  "/admin/site",
  (websiteTitle, homepageText) => (
    <>
      <h2>{t("site.home.heading")}</h2>

      <SiteTextForm
        action="/admin/site"
        html={siteHomeForm.render({
          homepage_text: homepageText,
          website_title: websiteTitle,
        })}
      />
    </>
  ),
);

/** State of the optional public contact form feature */
interface ContactFormState {
  /** Whether Botpoison spam protection is configured (env keys set) */
  botpoisonEnabled: boolean;
  /** Whether the owner has enabled the form */
  enabled: boolean;
  /** Whether a business email is set (required for delivery) */
  hasBusinessEmail: boolean;
}

/** Spam-protection status note: Botpoison is an optional enhancement. */
const SpamProtectionNote = ({
  botpoisonEnabled,
}: {
  botpoisonEnabled: boolean;
}): JSX.Element =>
  botpoisonEnabled ? (
    <p>
      <small>Spam protection: Botpoison is active.</small>
    </p>
  ) : (
    <p>
      <small>
        No spam-protection provider is configured, so submissions are accepted
        without a spam check. Set <code>BOTPOISON_PUBLIC_KEY</code> and{" "}
        <code>BOTPOISON_SECRET_KEY</code> to enable Botpoison.
      </small>
    </p>
  );

/** Toggle for the public contact form (always available; Botpoison optional) */
const ContactFormToggle = ({
  enabled,
  hasBusinessEmail,
  botpoisonEnabled,
}: ContactFormState): JSX.Element => (
  <SaveForm action="/admin/site/contact/form" submitLabel={t("common.save")}>
    <div class="prose">
      <h2>{t("site.contact_form_heading")}</h2>
      <p>
        Add a contact form to the public contact page. Visitors enter their
        email address and a message, which is sent to your business email.
      </p>
      {!hasBusinessEmail && (
        <ErrorNote>
          Set a business email on the Settings page to receive contact form
          messages.
        </ErrorNote>
      )}
    </div>
    <SpamProtectionNote botpoisonEnabled={botpoisonEnabled} />
    <label>
      <input
        checked={enabled}
        name="contact_form_enabled"
        type="checkbox"
        value="true"
      />{" "}
      Enable contact form
    </label>
  </SaveForm>
);

/**
 * Contact page editor
 */
export const adminSiteContactPage = siteDataPage<string, ContactFormState>(
  t("site.contact_title"),
  "/admin/site/contact",
  (contactPageText, contactForm) => (
    <>
      <h2>{t("site.contact.heading")}</h2>

      <SiteTextForm
        action="/admin/site/contact"
        html={siteContactForm.render({
          contact_page_text: contactPageText,
        })}
      />

      <ContactFormToggle
        botpoisonEnabled={contactForm.botpoisonEnabled}
        enabled={contactForm.enabled}
        hasBusinessEmail={contactForm.hasBusinessEmail}
      />
    </>
  ),
);

/** State of the optional public order page feature */
interface OrderPageState {
  /** Whether the owner has enabled the order page */
  enabled: boolean;
  /** Number of active, visible listings that appear on the order page */
  listingCount: number;
}

/** Note about how many listings will appear on the order page (or a warning
 * when there are none, since the page would render empty). */
const OrderListingsNote = ({
  listingCount,
}: {
  listingCount: number;
}): JSX.Element =>
  listingCount === 0 ? (
    <ErrorNote>
      You have no bookable listings yet. <a href="/admin/">Create a listing</a>{" "}
      for it to appear on the order page.
    </ErrorNote>
  ) : (
    <p>
      <small>
        {listingCount} {listingCount === 1 ? "listing" : "listings"} will be
        shown on the order page.
      </small>
    </p>
  );

/**
 * Order page editor — toggle the public `/order` gallery on/off and edit the
 * intro text shown above the item grid.
 */
export const adminSiteOrderPage = siteDataPage<string, OrderPageState>(
  t("site.order_title"),
  "/admin/site/order",
  (introText, state) => (
    <>
      <div class="prose">
        <h2>{t("site.order_page_heading")}</h2>
        <p>
          Publish an <code>/order</code> page that shows your bookable listings
          in a gallery. Visitors tick the items they want and continue to a
          booking page pre-filled with their selection.
        </p>
        <OrderListingsNote listingCount={state.listingCount} />
      </div>

      <SaveForm
        action="/admin/site/order/toggle"
        submitLabel={t("common.save")}
      >
        <label>
          <input
            checked={state.enabled}
            name="order_enabled"
            type="checkbox"
            value="true"
          />{" "}
          Enable order page
        </label>
      </SaveForm>

      <SiteTextForm
        action="/admin/site/order"
        html={siteOrderForm.render({ order_intro_text: introText })}
      />
    </>
  ),
);
