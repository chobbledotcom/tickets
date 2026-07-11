/**
 * Admin site page editor templates
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  siteContactForm,
  siteHomeForm,
  siteOrderForm,
} from "#routes/admin/site.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminLevel, AdminSession } from "#shared/types.ts";
import { flashAdminPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter, SaveButton } from "#templates/components/actions.tsx";
import { ErrorNote } from "#templates/components/error.tsx";

/* jscpd:ignore-end */

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

/**
 * Homepage editor - website title + homepage text
 */
export const adminSiteHomePage = (
  session: AdminSession,
  websiteTitle: string,
  homepageText: string,
  error?: string,
  success?: string,
): string =>
  flashAdminPage(t("site.home_title"), "/admin/site")(session, error, success)(
    <>
      <h2>{t("site.home.heading")}</h2>

      <CsrfForm action="/admin/site">
        <Raw
          html={siteHomeForm.render({
            homepage_text: homepageText,
            website_title: websiteTitle,
          })}
        />
        {SaveButton()}
      </CsrfForm>

      <SiteGuideFooter adminLevel={session.adminLevel} />
    </>,
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
  <CsrfForm action="/admin/site/contact/form">
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
    {SaveButton()}
  </CsrfForm>
);

/**
 * Contact page editor
 */
export const adminSiteContactPage = (
  session: AdminSession,
  contactPageText: string,
  contactForm: ContactFormState,
  error?: string,
  success?: string,
): string =>
  flashAdminPage(t("site.contact_title"), "/admin/site/contact")(
    session,
    error,
    success,
  )(
    <>
      <h2>{t("site.contact.heading")}</h2>

      <CsrfForm action="/admin/site/contact">
        <Raw
          html={siteContactForm.render({
            contact_page_text: contactPageText,
          })}
        />
        {SaveButton()}
      </CsrfForm>

      <ContactFormToggle
        botpoisonEnabled={contactForm.botpoisonEnabled}
        enabled={contactForm.enabled}
        hasBusinessEmail={contactForm.hasBusinessEmail}
      />

      <SiteGuideFooter adminLevel={session.adminLevel} />
    </>,
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
export const adminSiteOrderPage = (
  session: AdminSession,
  introText: string,
  state: OrderPageState,
  error?: string,
  success?: string,
): string =>
  flashAdminPage(t("site.order_title"), "/admin/site/order")(
    session,
    error,
    success,
  )(
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

      <CsrfForm action="/admin/site/order/toggle">
        <label>
          <input
            checked={state.enabled}
            name="order_enabled"
            type="checkbox"
            value="true"
          />{" "}
          Enable order page
        </label>
        {SaveButton()}
      </CsrfForm>

      <CsrfForm action="/admin/site/order">
        <Raw html={siteOrderForm.render({ order_intro_text: introText })} />
        {SaveButton()}
      </CsrfForm>

      <SiteGuideFooter adminLevel={session.adminLevel} />
    </>,
  );
