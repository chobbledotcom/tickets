/**
 * Admin guide page template - FAQ-style help for administrators
 */

import { t } from "#i18n";
import {
  API_AVAILABILITY_EXAMPLE_JSON,
  API_BOOK_FREE_EXAMPLE_JSON,
  API_BOOK_PAID_EXAMPLE_JSON,
  API_BOOK_REQUEST_JSON,
  API_LIST_EXAMPLE_JSON,
  API_SINGLE_EXAMPLE_JSON,
} from "#shared/api-example.ts";
import { buildDefaultTemplate } from "#shared/column-order.ts";
import {
  ATTENDEE_DEFAULT_ORDER,
  ATTENDEE_TABLE_COLUMNS,
} from "#shared/columns/attendee-columns.ts";
import {
  LISTING_DEFAULT_ORDER,
  LISTING_TABLE_COLUMNS,
} from "#shared/columns/listing-columns.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { formatCurrency } from "#shared/currency.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { LOGIN_LOCKOUT_MS, MAX_LOGIN_ATTEMPTS } from "#shared/limits.ts";
import { type AdminSession, MAX_DURATION_DAYS } from "#shared/types.ts";
import { WEBHOOK_EXAMPLE_JSON } from "#shared/webhook-example.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

/** Host-level configuration info passed from the route */
export type GuideHostConfig = {
  hostEmailProvider: string | null;
  hostEmailFromAddress: string | null;
  hostAppleWalletPassTypeId: string | null;
  hostGoogleWalletIssuerId: string | null;
  builderEnabled: boolean;
  bunnyDnsSubdomainSuffix: string | null;
};

/** Render a column reference table from column generators */
const columnReferenceTable = (
  columns: Record<string, { label: string; description: string }>,
): string => {
  const rows = Object.entries(columns)
    .map(
      ([key, col]) =>
        `<tr>
          <td><code>{{${key}}}</code></td>
          <td>${col.label}</td>
          <td>${col.description}</td>
        </tr>`,
    )
    .join("");
  return [
    "<table>",
    "<thead><tr><th>Tag</th><th>Label</th><th>Description</th></tr></thead>",
    `<tbody>${rows}</tbody>`,
    "</table>",
  ].join("");
};

const Section = ({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children?: Child;
}): JSX.Element => (
  <div class="stack-md column">
    <h3 id={id}>{title}</h3>
    {children}
  </div>
);

const Q = ({ q, children }: { q: string; children?: Child }): JSX.Element => (
  <details>
    <summary>{q}</summary>
    {children}
  </details>
);

/**
 * Admin guide page
 */
const Faq = ({ id }: { id: string }): JSX.Element => (
  <Q q={t(`guide.q.${id}`)}>
    <Raw html={t(`guide.a.${id}`)} />
  </Q>
);

export const adminGuidePage = (
  adminSession: AdminSession,
  hostConfig?: GuideHostConfig,
): string =>
  String(
    <Layout bodyClass="guide" title={t("guide.title")}>
      <AdminNav active="/admin/guide" session={adminSession} />

      <div class="prose">
        <h2>{t("guide.title")}</h2>

        <p class="search-hint">
          Press <kbd>Ctrl</kbd>+<kbd>F</kbd> (or <kbd>&#8984;</kbd>+<kbd>F</kbd>{" "}
          on Mac) to search this page.
        </p>
      </div>

      <Section title={t("guide.sections.getting_started")}>
        <Q q={t("guide.q.create_listing")}>
          <p>
            From the <strong>Listings</strong> page, click{" "}
            <strong>Add Listing</strong>. Give your listing a name, set the
            capacity, and choose which contact details to collect (any
            combination of email, phone, postal address, and special
            instructions &mdash; or none at all for name-only registration). You
            can leave the price blank for free listings. Once created, share the
            booking link with your attendees.
          </p>
        </Q>

        <Faq id="setup_payments" />
      </Section>

      <Section title={t("guide.sections.dashboard")}>
        <Q q={t("guide.q.what_is_dashboard")}>
          <p>
            The <strong>Listings</strong> page is your dashboard. It lists all
            your listings with attendee counts, booking links, and quick
            actions. At the top, the <strong>Active Listing Statistics</strong>{" "}
            section shows totals across all active listings: total income,
            number of ticket rows, and total attendee quantity. Click the
            heading to expand or collapse it.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.testing_your_system")}>
        <Faq id="test_after_changing_settings" />

        <Q q={t("guide.q.report_bug")}>
          <p>
            This project is early in development (started January 2026) and bugs
            are expected. If you find something that doesn&apos;t work
            correctly, please email{" "}
            <a href="mailto:hello@chobble.com">hello@chobble.com</a> with a
            description of what happened and what you expected. The more detail
            you can provide, the faster it can be fixed.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.listings")}>
        <Q q={t("guide.q.standard_vs_daily_listings")}>
          <p>
            A <strong>standard listing</strong> is a one-off &mdash; attendees
            book a place and the capacity applies to the whole listing. A{" "}
            <strong>daily listing</strong> lets attendees pick a specific date
            when booking. The capacity limit applies separately to each date, so
            you can run the same listing every day with a fresh allocation.
          </p>
        </Q>

        <Q q={t("guide.q.combine_multiple_listings")}>
          <p>
            Join listing slugs with a <code>+</code> in the URL, e.g.{" "}
            <code>/ticket/listing-one+listing-two</code>. Attendees see a single
            form, fill in their details once, and book all selected listings in
            one go. If any are paid, they complete one checkout for the total.
          </p>
          <p>
            The attendee gets a single ticket with one QR code covering all
            their listings. Their ticket page shows one card per listing. In the
            admin, they appear as one attendee linked to multiple listings.
          </p>
          <p>
            If the listings have different contact-detail settings, the combined
            form asks for the union of all selected fields &mdash; so pairing an
            email-only listing with one that also collects a phone number will
            require both from every attendee. Fields always appear in the same
            order (email, phone, address, special instructions) regardless of
            which listings are combined.
          </p>
          <p>
            To generate the link, open the <strong>Multi-booking link</strong>{" "}
            section on the <strong>Listings</strong> page and tick the listings
            you want to combine. The link updates as you select, and listings
            appear in the order you tick them.
          </p>
        </Q>

        <Q q={t("guide.q.what_are_groups")}>
          <p>
            Groups let you bundle related listings under a single URL. Create a
            group from the <strong>Groups</strong> page, then assign listings to
            it using the group dropdown on the listing form. Share{" "}
            <code>/ticket/your-group-slug</code> and attendees see all active
            listings in the group on one page. You can optionally set a maximum
            attendee limit on the group to cap total bookings across all
            listings in it. If you add terms and conditions to a group, they
            replace the global T&amp;Cs for that page.
          </p>
        </Q>

        <Faq id="listing_date_and_location" />

        <Faq id="max_tickets_per_purchase" />

        <Q q={t("guide.q.allow_pay_more")}>
          <p>
            When enabled, attendees can choose their own price instead of paying
            a fixed amount. The ticket price becomes a minimum. You can set a
            maximum price using the "Maximum Price" field — it must be at least{" "}
            {formatCurrency(100)} more than the ticket price. If the ticket
            price is zero, it becomes a pay-what-you-want listing where
            attendees can optionally enter any amount up to the configured
            maximum.
          </p>
        </Q>

        <Faq id="what_is_purchase_only_mode" />

        <Faq id="registration_deadlines" />

        <Q q={t("guide.q.embed_booking_form")}>
          <p>
            You only need <strong>one</strong> of the two embed codes shown on
            your listing page &mdash; not both:
          </p>
          <ul>
            <li>
              <strong>Embed Script</strong> (recommended) &mdash; paste a single{" "}
              <code>&lt;script&gt;</code> tag and it creates the iframe for you
              with automatic resizing.
            </li>
            <li>
              <strong>Embed Iframe</strong> &mdash; use this if your hosting
              platform blocks third-party scripts or if you want full control
              over the iframe styling yourself.
            </li>
          </ul>
          <p>
            In <strong>Settings</strong>, add your website's domain to the embed
            hosts list to restrict which sites can embed your forms. If no hosts
            are listed, embedding is allowed from any site.
          </p>
        </Q>

        <Q q={t("guide.q.manually_add_attendee")}>
          <p>
            Open the listing page and scroll down to{" "}
            <strong>Add Attendee</strong>. Fill in the name and contact details,
            set the quantity, and submit. The attendee is added directly without
            needing to go through the booking form or payment flow. Useful for
            walk-ins, comps, or manual corrections.
          </p>
        </Q>

        <Faq id="custom_redirect_after_booking" />

        <Faq id="add_listing_image" />

        <Q q={t("guide.q.add_file_attachment")}>
          <p>
            When creating or editing a listing, use the attachment upload field
            to attach a file. This can be any type of file &mdash; PDFs, Word
            documents, spreadsheets, images, audio, video, zip archives, you
            name it. The maximum file size is 25&nbsp;MB.
          </p>
          <p>
            Attendees see a download link on their ticket page. The link is
            time-limited and unique to each attendee, so it can't be shared or
            reused by others. Each time an attendee visits their ticket page,
            they get a fresh link that works for a short window.
          </p>
          <p>
            To remove an attachment, open the listing and click{" "}
            <strong>Delete</strong> next to the current file name.
          </p>
        </Q>

        <Faq id="listing_qr_code" />

        <Faq id="duplicate_listing" />

        <Q q={t("guide.q.deactivate_listing")}>
          <p>
            Open the listing and click <strong>Deactivate</strong>. Deactivated
            listings no longer accept bookings and are hidden from the public
            listings list, but all existing attendee data is kept. Click{" "}
            <strong>Reactivate</strong> to make the listing bookable again.
          </p>
        </Q>

        <Faq id="non_transferable_tickets" />

        <Q q={t("guide.q.edit_attendee")}>
          <p>
            Open the listing's attendee list, find the attendee, and click{" "}
            <strong>Edit</strong>. The edit page has three sections:
          </p>
          <ul>
            <li>
              <strong>Contact Information</strong> &mdash; name, email, phone,
              address, special instructions, and custom question answers. These
              are shared across all the attendee's listing registrations.
            </li>
            <li>
              <strong>Listing Registrations</strong> &mdash; a table showing
              each listing the attendee is registered for, with their quantity,
              check-in status, and refund status. You can update the quantity
              per listing or remove a registration.
            </li>
            <li>
              <strong>Add to Listing</strong> &mdash; link the attendee to an
              additional listing. For daily listings, you also pick a date.
              Capacity is checked when adding.
            </li>
          </ul>
        </Q>

        <Q q="How do I add an attendee to another listing?">
          <p>
            Open the attendee's edit page and use the{" "}
            <strong>Add to Listing</strong> section at the bottom. Select the
            listing, choose a quantity, and for daily listings pick a date. If
            the listing has enough capacity the attendee is linked immediately.
          </p>
        </Q>

        <Q q="How do I remove an attendee from a listing?">
          <p>
            On the attendee's edit page, find the listing in the{" "}
            <strong>Listing Registrations</strong> table and click{" "}
            <strong>Remove</strong>. If the attendee is registered for other
            listings they stay in the system. If it was their only listing, the
            attendee is deleted entirely.
          </p>
        </Q>

        <Q q="How do I delete an attendee?">
          <p>
            Open the listing's attendee list and click <strong>Delete</strong>{" "}
            next to the attendee. You'll see a confirmation page showing their
            name, email, quantity, and registration date. Type the attendee's
            exact name to confirm, then click <strong>Delete Attendee</strong>.
            This permanently removes the attendee and any associated payment
            records.
          </p>
          <p>
            If the attendee has paid, <strong>refund them first</strong> before
            deleting &mdash; once deleted, there is no payment record to refund
            against. See the <strong>Refunds</strong> section below.
          </p>
        </Q>

        <Faq id="how_do_i_merge_duplicate_attendees" />

        <Q q="How do I resend a confirmation email?">
          <p>
            In the listing's attendee list, click{" "}
            <strong>Re-send Notification</strong> next to the attendee. You'll
            be asked to type their name to confirm. This re-sends both the
            attendee confirmation email (with their ticket link) and the admin
            notification email. If email is not configured or the attendee has
            no email address, the action completes silently without sending.
          </p>
        </Q>

        <Faq id="add_terms_and_conditions" />
      </Section>

      <Section id="questions" title={t("guide.sections.booking_questions")}>
        <Faq id="what_are_custom_booking_questions" />

        <Faq id="create_question" />

        <Q q={t("guide.q.add_question_to_listing")}>
          <p>
            Open the listing in the admin area and click{" "}
            <strong>Questions</strong>. Tick the questions you want to appear on
            that listing's booking form and save. The same question can be
            shared across multiple listings &mdash; create it once and assign it
            wherever you need it.
          </p>
        </Q>

        <Faq id="share_questions_between_listings" />

        <Faq id="where_to_see_answers" />
      </Section>

      <Section title={t("guide.sections.public_links")}>
        <Q q={t("guide.q.facebook_403_error")}>
          <p>
            When you first share a link from a new domain on Facebook, Facebook
            may return a 403 error. This is because Facebook doesn't recognise
            the domain yet &mdash; the error comes from Facebook itself and
            doesn't even reach your site.
          </p>
          <p>
            To fix this, paste your public link into the{" "}
            <a href="https://developers.facebook.com/tools/debug/">
              Facebook Sharing Debugger
            </a>{" "}
            and click <strong>Scrape Again</strong> if the result looks wrong.
            Once Facebook has successfully scraped the URL, future shares should
            work normally.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.public_site")}>
        <Q q={t("guide.q.what_is_public_site")}>
          <p>
            When enabled in <strong>Settings</strong>, your domain shows a
            public website with navigation for Home and Listings, plus T&amp;Cs
            and Contact links if you've set those up. The{" "}
            <strong>Listings</strong> page lists all active listings with
            booking links. Visitors can browse listing details and book
            directly. If the public site is disabled, visitors can still book
            via direct ticket links.
          </p>
        </Q>

        <Q q={t("guide.q.hide_listing_from_public_list")}>
          <p>
            Yes. When editing a listing, tick the{" "}
            <strong>Hidden Listing</strong> checkbox. Hidden listings won&apos;t
            appear on the public Listings page and their ticket pages will be
            marked as <code>noindex, nofollow</code> for search engines. The
            listing is still fully bookable via its direct link or when embedded
            in an iframe.
          </p>
        </Q>

        <Q q={t("guide.q.edit_homepage_and_contact")}>
          <p>
            Enable the public site in <strong>Settings</strong>, then open the{" "}
            <strong>Site</strong> section from the admin navigation. The
            homepage editor lets you set a website title (shown as the heading
            on all public pages) and homepage text. The contact page editor lets
            you set contact information. Both fields support Markdown
            formatting.
          </p>
        </Q>
      </Section>

      <Section id="text-formatting" title={t("guide.sections.text_formatting")}>
        <Q q={t("guide.q.fields_support_formatting")}>
          <p>
            Listing descriptions, terms and conditions, homepage text, and
            contact page text all support{" "}
            <a href="https://www.markdownguide.org/cheat-sheet/">Markdown</a>{" "}
            formatting.
          </p>
        </Q>

        <Q q={t("guide.q.what_formatting_can_i_use")}>
          <p>
            <strong>Bold</strong> with <code>**bold**</code>, <em>italic</em>{" "}
            with <code>*italic*</code>, links with{" "}
            <code>[text](https://...)</code>, and lists with <code>-</code> at
            the start of a line. See the{" "}
            <a href="https://www.markdownguide.org/cheat-sheet/">
              Markdown cheat sheet
            </a>{" "}
            for more options.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.payments")}>
        <Q q={t("guide.q.supported_payment_providers")}>
          <p>
            <strong>Stripe</strong>, <strong>Square</strong>, and{" "}
            <strong>SumUp</strong>. Choose one in Settings and enter your API
            credentials. You can switch between them at any time.
          </p>
          <p>
            <strong>SumUp</strong> only works with a limited set of currencies
            (mostly European currencies plus GBP, USD, and BRL). If your site
            currency isn't supported, the Settings page will refuse the
            credentials and tell you to pick a different provider or country.
          </p>
        </Q>

        <Faq id="recommended_payment_provider" />

        <Q q={t("guide.q.paid_ticket_booking_flow")}>
          <p>
            They fill in the booking form, then are redirected to your payment
            provider's checkout page. Once their payment is confirmed, their
            place is recorded and they receive their ticket. Their place is
            <strong>not</strong> held while they're paying &mdash; see{" "}
            <em>Why don't we hold places during checkout?</em> below for the
            reason.
          </p>
        </Q>

        <Faq id="why_don_t_we_hold_places_during" />

        <Faq id="listing_sells_out_while_paying" />

        <Faq id="how_refunds_work" />

        <Q q={t("guide.q.what_is_booking_fee")}>
          <p>
            The booking fee is an optional percentage-based charge added to
            ticket prices at checkout. For example, if you set a 2% booking fee
            on a {formatCurrency(1000)} ticket, the attendee pays{" "}
            {formatCurrency(1020)} in total.
          </p>
          <p>
            Configure it in <a href="/admin/settings">Settings</a> under{" "}
            <strong>Booking Fee</strong> (only visible when a payment provider
            is set up). Enter a percentage between 0 and 10. Set it to 0 or
            leave it blank to disable. The fee is calculated on the subtotal and
            added automatically during checkout.
          </p>
        </Q>
      </Section>

      <Section id="payment-setup" title={t("guide.sections.payment_setup")}>
        <Q q={t("guide.q.find_stripe_secret_key")}>
          <ol>
            <li>
              Log in to your{" "}
              <a href="https://dashboard.stripe.com">Stripe Dashboard</a>
            </li>
            <li>
              Click <strong>Developers</strong> in the navigation menu
            </li>
            <li>
              Select <strong>API keys</strong> from the sidebar
            </li>
            <li>
              Under <strong>Standard keys</strong>, find the{" "}
              <strong>Secret key</strong> row and click <strong>Reveal</strong>
            </li>
            <li>
              Copy the key &mdash; it starts with <code>sk_live_</code> for live
              mode or <code>sk_test_</code> for test mode
            </li>
            <li>
              Paste it into the Stripe Secret Key field on the{" "}
              <a href="/admin/settings">Settings</a> page
            </li>
          </ol>
          <p>
            <strong>Tip:</strong> Use a <code>sk_test_</code> key first to
            verify everything works before switching to your live key. Test mode
            lets you make bookings without real charges.
          </p>
        </Q>

        <Q q={t("guide.q.stripe_webhook_setup")}>
          <p>
            No. When you save your Stripe secret key in{" "}
            <a href="/admin/settings">Settings</a>, the system automatically
            creates a webhook endpoint in your Stripe account and stores the
            signing secret. You can verify it's working by clicking the{" "}
            <strong>Test Connection</strong> button that appears after saving
            your key.
          </p>
        </Q>

        <Q q={t("guide.q.create_square_application")}>
          <p>
            Before you can accept payments with Square, you need to create an
            application in the Square Developer Dashboard. This gives you the
            API credentials the system needs.
          </p>
          <ol>
            <li>
              Go to the{" "}
              <a href="https://developer.squareup.com/apps">
                Square Developer Dashboard
              </a>{" "}
              and sign in with your Square account
            </li>
            <li>
              Click the <strong>+</strong> button to create a new application
            </li>
            <li>
              Give it a name (e.g. your organisation or listing name) and click{" "}
              <strong>Save</strong>
            </li>
          </ol>
          <p>
            Once created, you can find your access token and location ID from
            the application's pages (see below).
          </p>
        </Q>

        <Q q={t("guide.q.find_square_access_token")}>
          <ol>
            <li>
              Log in to the{" "}
              <a href="https://developer.squareup.com/apps">
                Square Developer Dashboard
              </a>
            </li>
            <li>Select your application</li>
            <li>
              Open the <strong>Credentials</strong> page
            </li>
            <li>
              Copy the <strong>Access token</strong> for the environment you
              want (Sandbox for testing, Production for real payments)
            </li>
            <li>
              Paste it into the Square Access Token field on the{" "}
              <a href="/admin/settings">Settings</a> page
            </li>
          </ol>
        </Q>

        <Q q={t("guide.q.find_square_location_id")}>
          <ol>
            <li>
              Log in to the{" "}
              <a href="https://developer.squareup.com/apps">
                Square Developer Dashboard
              </a>{" "}
              and select your application
            </li>
            <li>
              Open the <strong>Locations</strong> page in the sidebar
            </li>
            <li>
              Copy the <strong>Location ID</strong> for the location you want to
              accept payments at
            </li>
          </ol>
          <p>
            You can also find your location ID in the main{" "}
            <a href="https://squareup.com/dashboard">Square Dashboard</a> under{" "}
            <strong>Account &amp; Settings</strong> &rarr;{" "}
            <strong>Business information</strong> &rarr;{" "}
            <strong>Locations</strong>.
          </p>
        </Q>

        <Q q={t("guide.q.setup_square_webhook")}>
          <p>
            Unlike Stripe, the Square webhook must be configured manually. After
            saving your Square access token and location ID:
          </p>
          <ol>
            <li>
              Go to the{" "}
              <a href="https://developer.squareup.com/apps">
                Square Developer Dashboard
              </a>{" "}
              and select your application
            </li>
            <li>
              Navigate to <strong>Webhooks</strong> in the sidebar
            </li>
            <li>
              Click <strong>Add Subscription</strong>
            </li>
            <li>
              Set the <strong>Notification URL</strong> to the webhook URL shown
              on your <a href="/admin/settings">Settings</a> page
            </li>
            <li>
              Subscribe to the <strong>payment.updated</strong> event
            </li>
            <li>
              Save the subscription, then copy the{" "}
              <strong>Signature Key</strong> that Square provides
            </li>
            <li>
              Paste the signature key into the webhook field on your{" "}
              <a href="/admin/settings">Settings</a> page
            </li>
          </ol>
          <p>
            The webhook is what tells the system when a payment has been
            completed, so bookings won't be confirmed until this is set up.
          </p>
        </Q>

        <Q q="How do I set up SumUp?">
          <p>
            SumUp uses its Hosted Checkout, and the webhook is handled
            automatically &mdash; there's nothing to configure in the SumUp
            dashboard. You need two values:
          </p>
          <ol>
            <li>
              <strong>API Key</strong> &mdash; a secret API key from your SumUp
              account, starting with <code>sk_live_</code> (real payments) or{" "}
              <code>sk_test_</code> (testing). Create one under{" "}
              <strong>Developers</strong> &rarr; <strong>API keys</strong> in
              the SumUp dashboard.
            </li>
            <li>
              <strong>Merchant Code</strong> &mdash; your SumUp merchant code
              (e.g. <code>MC...</code>), shown in your SumUp dashboard.
            </li>
          </ol>
          <p>
            Paste both into the SumUp section on the{" "}
            <a href="/admin/settings">Settings</a> page and save. As with
            Stripe, the Settings page shows a <strong>Test mode</strong> or{" "}
            <strong>Live mode</strong> badge based on your key prefix, and a{" "}
            <strong>Test Connection</strong> button to verify it works.
          </p>
          <p>
            SumUp only supports certain currencies. If your site currency isn't
            one of them, saving the credentials is blocked with a message asking
            you to choose a different provider or country.
          </p>
        </Q>

        <Q q={t("guide.q.stripe_test_vs_live_keys")}>
          <p>
            Stripe provides two completely separate environments, each with its
            own set of API keys:
          </p>
          <ul>
            <li>
              <strong>Test mode</strong> (<code>sk_test_</code> /{" "}
              <code>pk_test_</code>) &mdash; a sandbox environment for
              development and testing. No real money is moved. You can use{" "}
              <a href="https://docs.stripe.com/testing#cards">
                Stripe&apos;s test card numbers
              </a>{" "}
              to simulate successful and failed payments. Bookings created in
              test mode won&apos;t appear in your live Stripe dashboard.
            </li>
            <li>
              <strong>Live mode</strong> (<code>sk_live_</code> /{" "}
              <code>pk_live_</code>) &mdash; the production environment. Real
              cards are charged and real money is transferred to your Stripe
              account.
            </li>
          </ul>
          <p>
            The system detects which mode you are in based on the key prefix and
            shows it on the <a href="/admin/settings">Settings</a> page. Only
            keys with a valid prefix (<code>sk_test_</code> or{" "}
            <code>sk_live_</code>) are accepted.
          </p>
        </Q>

        <Q q={t("guide.q.test_or_live_credentials")}>
          <p>
            Start with test credentials to make sure everything is working
            before accepting real payments. All three providers offer separate
            test environments:
          </p>
          <ul>
            <li>
              <strong>Stripe:</strong> Use a key starting with{" "}
              <code>sk_test_</code>. You can make test payments with{" "}
              <a href="https://docs.stripe.com/testing#cards">
                Stripe&apos;s test card numbers
              </a>
              . The Settings page will show a <strong>Test mode</strong> badge
              so you always know which environment is active.
            </li>
            <li>
              <strong>Square:</strong> Use your Sandbox access token and
              location, and tick the <strong>Sandbox mode</strong> checkbox on
              the Settings page. You can make test payments with{" "}
              <a href="https://developer.squareup.com/docs/devtools/sandbox/payments">
                Square&apos;s sandbox test values
              </a>
              . Untick Sandbox mode when switching to production.
            </li>
            <li>
              <strong>SumUp:</strong> Use an API key starting with{" "}
              <code>sk_test_</code>. As with Stripe, the Settings page shows a{" "}
              <strong>Test mode</strong> badge so you know which environment is
              active. Swap to your <code>sk_live_</code> key to go live.
            </li>
          </ul>
          <p>
            When you&apos;re ready to go live, replace the test credentials with
            your production credentials in{" "}
            <a href="/admin/settings">Settings</a>. For Stripe, the system will
            only accept keys that start with a valid prefix (
            <code>sk_test_</code> or <code>sk_live_</code>).
          </p>
        </Q>
      </Section>

      <Section id="refunds" title={t("guide.sections.refunds")}>
        <Q q={t("guide.q.automatic_refunds")}>
          <p>
            A place is only ever counted once payment completes &mdash; nothing
            is held during checkout (see{" "}
            <em>Why don't we hold places during checkout?</em> above). Because
            of that, a completed payment can occasionally find that the booking
            is no longer possible, and in those cases the payment is refunded
            automatically. This happens when, by the time the payment is
            confirmed:
          </p>
          <ul>
            <li>
              the listing has <strong>sold out</strong> &mdash; another buyer
              took the last spot first, so the slower payer is refunded and
              shown a message explaining the listing is full;
            </li>
            <li>
              the <strong>price has changed</strong> &mdash; an admin edited the
              listing price mid-checkout, so the amount charged no longer
              matches the current price;
            </li>
            <li>
              the listing has been <strong>closed or deactivated</strong> while
              the buyer was paying.
            </li>
          </ul>
          <p>
            In multi-listing bookings it's all-or-nothing: if any single listing
            fails (e.g. one of the combined listings is full or its price
            changed), the entire payment is refunded &mdash; not just the
            portion for the affected listing.
          </p>
        </Q>

        <Q q={t("guide.q.refund_individual_attendee")}>
          <p>
            Open the listing's attendee list, find the attendee, and click{" "}
            <strong>Refund</strong>. You'll see a confirmation page showing
            their name, email, quantity, and the amount paid. Type the
            attendee's name to confirm and submit. The refund is issued through
            your payment provider (Stripe, Square, or SumUp) and is always a
            full refund.
          </p>
        </Q>

        <Faq id="refund_all_attendees" />

        <Faq id="partial_refunds" />

        <Faq id="is_the_booking_fee_refunded_too" />

        <Faq id="attendee_after_refund" />

        <Faq id="refund_free_listing" />

        <Faq id="refund_fails" />

        <Faq id="refund_same_attendee_twice" />
      </Section>

      <Section
        id="holidays"
        title={t("guide.sections.daily_listings_and_holidays")}
      >
        <Faq id="how_daily_listings_work" />

        <Faq id="what_are_bookable_days" />

        <Q q="What is the Booking Duration field?">
          <p>
            For daily listings, <strong>Booking Duration (days)</strong> sets
            how many consecutive days a single booking reserves &mdash; useful
            for multi-night stays or multi-day passes. Leave it at 1 for a
            normal single-day booking, or set it up to {MAX_DURATION_DAYS} days.
            The attendee picks a start date and their booking spans that many
            days from it.
          </p>
          <p>
            Capacity is checked for <strong>every</strong> day the booking
            covers, so a place is only confirmed if all of those days have room.
            On the ticket and in the attendee table, the booking shows as a date
            range rather than a single day. The field only appears on daily
            listings &mdash; standard (one-off) listings don't use it.
          </p>
          <p>
            If you change the duration on a listing that already has bookings,
            the system recalculates the date range of every existing booking and
            warns you before saving, since this can affect how many places each
            day has left.
          </p>
        </Q>

        <Faq id="what_are_holidays" />
      </Section>

      <Section id="checkin" title={t("guide.sections.check_in_and_qr_scanner")}>
        <Faq id="how_checkin_works" />

        <Faq id="qr_code_purpose" />

        <Q q={t("guide.q.use_qr_scanner")}>
          <p>
            Open a listing and click <strong>Scanner</strong>. Tap{" "}
            <strong>Start Camera</strong> to begin (grants camera permission on
            first use). Point the camera at an attendee's QR code and check-in
            happens automatically. The scanner works best with the rear camera
            on mobile devices.
          </p>
        </Q>

        <Q q={t("guide.q.scanner_no_checkout")}>
          <p>
            The scanner is intentionally one-way: it only checks people{" "}
            <strong>in</strong>, never out. This prevents accidental check-outs
            from double-scans at a busy door. To check someone out, use the
            manual check-in page instead.
          </p>
        </Q>

        <Faq id="qr_different_listing" />

        <Q q={t("guide.q.scanner_status_messages")}>
          <p>
            <strong>Checked in</strong> &mdash; shows the attendee's name and
            ticket count (e.g. "Jo checked in (2 tickets)").{" "}
            <strong>Already checked in</strong> &mdash; they were already marked
            as arrived. <strong>Refunded</strong> &mdash; the attendee has been
            refunded and cannot be checked in. <strong>Ticket not found</strong>{" "}
            &mdash; the QR code doesn't match any registration.{" "}
            <strong>Different listing</strong> &mdash; a confirmation dialogue
            asks whether to check them in anyway.{" "}
            <strong>ID verification</strong> &mdash; for non-transferable
            listings, staff are asked to confirm the attendee's ID matches the
            ticket name before check-in proceeds.
          </p>
        </Q>

        <Q q="What if someone doesn't have their QR code?">
          <p>
            Below the camera on the Scanner page there is a{" "}
            <strong>Manual Check-in</strong> section. Start typing the
            attendee's name or ticket token and a dropdown shows matching
            tickets that haven't been checked in yet. Select the right person
            and click <strong>Check In</strong>. This is useful for walk-ins or
            when an attendee can't pull up their ticket on their phone.
          </p>
        </Q>

        <Q q="How do I filter attendees by check-in status?">
          <p>
            On the listing page, above the attendee table, you'll see filter
            links for <strong>All</strong>, <strong>Checked In</strong>, and{" "}
            <strong>Checked Out</strong>. Click one to show only attendees
            matching that status. The filter works alongside the date selector
            for daily listings, so you can view e.g. only un-checked-in
            attendees for a specific date. The CSV export reflects whichever
            filter is active.
          </p>
        </Q>
      </Section>

      <Section id="apple-wallet" title={t("guide.sections.apple_wallet")}>
        <Q q={t("guide.q.what_is_apple_wallet")}>
          <p>
            When configured, attendees see an{" "}
            <strong>Add to Apple Wallet</strong> button on their ticket page.
            Tapping it downloads a <code>.pkpass</code> file that adds the
            ticket to their iPhone Wallet and Apple Watch. The pass shows the
            listing name, date, location, ticket quantity, price paid, and a QR
            code for check-in.
          </p>
        </Q>

        <Q q={t("guide.q.setup_apple_wallet")}>
          {hostConfig?.hostAppleWalletPassTypeId && (
            <p>
              Apple Wallet is already configured by your server administrator
              using pass type{" "}
              <code>{hostConfig.hostAppleWalletPassTypeId}</code>. The Add to
              Apple Wallet button should appear automatically on all ticket
              pages. You can override this by entering your own credentials in{" "}
              <a href="/admin/settings">Settings</a>.
            </p>
          )}
          <p>
            Go to <a href="/admin/settings">Settings</a>, click{" "}
            <strong>Advanced Settings</strong>, and find the{" "}
            <strong>Apple Wallet</strong> section. You need five values from
            your Apple Developer account:
          </p>
          <ol>
            <li>
              <strong>Pass Type ID</strong> &mdash; e.g.{" "}
              <code>pass.com.example.tickets</code>
            </li>
            <li>
              <strong>Team ID</strong> &mdash; your Apple Developer Team ID
            </li>
            <li>
              <strong>Signing Certificate</strong> &mdash; PEM-encoded
              certificate for your Pass Type ID
            </li>
            <li>
              <strong>Signing Key</strong> &mdash; PEM-encoded private key for
              the certificate
            </li>
            <li>
              <strong>WWDR Certificate</strong> &mdash; Apple's intermediate
              certificate (download from the Apple Developer portal)
            </li>
          </ol>
          <p>
            All five fields are required. Once saved, the Add to Apple Wallet
            button appears automatically on all ticket pages. If none are
            configured, the feature is simply hidden.
          </p>
        </Q>

        <Faq id="wallet_passes_update" />
      </Section>

      <Section id="google-wallet" title="Google Wallet">
        <Q q="What is Google Wallet integration?">
          <p>
            When configured, attendees see an{" "}
            <strong>Add to Google Wallet</strong> button on their ticket page.
            Tapping it adds the ticket to their Android device's Google Wallet
            app. The pass shows the listing name, date, location, ticket
            quantity, price paid, and a QR code for check-in.
          </p>
        </Q>

        <Q q="How do I set up Google Wallet?">
          {hostConfig?.hostGoogleWalletIssuerId && (
            <p>
              Google Wallet is already configured by your server administrator
              using issuer ID <code>{hostConfig.hostGoogleWalletIssuerId}</code>
              . The Add to Google Wallet button should appear automatically on
              all ticket pages. You can override this by entering your own
              credentials in <a href="/admin/settings">Settings</a>.
            </p>
          )}
          <p>
            Go to <a href="/admin/settings">Settings</a>, click{" "}
            <strong>Advanced Settings</strong>, and find the{" "}
            <strong>Google Wallet</strong> section. You need three values from
            your Google Cloud account:
          </p>
          <ol>
            <li>
              <strong>Issuer ID</strong> &mdash; from the{" "}
              <a href="https://pay.google.com/business/console/">
                Google Wallet Business Console
              </a>
            </li>
            <li>
              <strong>Service Account Email</strong> &mdash; a Google Cloud
              service account with the Google Wallet API enabled
            </li>
            <li>
              <strong>Service Account Private Key</strong> &mdash; PEM-encoded
              RSA private key for the service account
            </li>
          </ol>
          <p>
            All three fields are required. Once saved, the Add to Google Wallet
            button appears automatically on all ticket pages. If none are
            configured, the feature is simply hidden.
          </p>
        </Q>

        <Faq id="do_google_wallet_passes_update_automatically" />
      </Section>

      <Section
        id="user-classes"
        title={t("guide.sections.users_and_permissions")}
      >
        <Faq id="owner_vs_manager" />

        <Faq id="invite_admin" />

        <Faq id="invite_link_expiry" />
      </Section>

      <Section id="login-security" title="Login &amp; Security">
        <Q q="What happens if I enter the wrong password?">
          <p>
            After <strong>5 failed login attempts</strong> from the same IP
            address, the system locks out that IP for{" "}
            <strong>15 minutes</strong>. During the lockout, all login attempts
            from that IP are rejected &mdash; even with the correct password.
            Wait for the lockout period to pass and try again.
          </p>
        </Q>

        <Faq id="why_am_i_locked_out_even_though" />

        <Faq id="is_there_a_way_to_recover_a" />

        <Faq id="how_are_admin_sessions_secured" />
      </Section>

      <Section title={t("guide.sections.data_and_privacy")}>
        <Faq id="attendee_data_protection" />

        <Faq id="lost_password" />

        <Q q={t("guide.q.export_attendee_data")}>
          <p>
            Yes. On any listing's attendee list, click{" "}
            <strong>Export CSV</strong>. The export includes name, email, phone,
            address, special instructions, quantity, registration date, amount
            paid, transaction ID, check-in status, ticket token, and ticket URL.
            If the listing has custom booking questions, each question is
            appended as an additional column (one per question, in the order
            assigned to the listing) with the attendee's selected answer text.
            For daily listings, the attendee list has a date filter &mdash;
            select a date to see only that day's attendees, and the CSV export
            respects the same filter.
          </p>
        </Q>

        <Faq id="reset_database" />
      </Section>

      <Section id="webhooks" title={t("guide.sections.webhooks")}>
        <Faq id="what_are_webhooks" />

        <Faq id="setup_webhook" />

        <Q q={t("guide.q.webhook_json_format")}>
          <p>
            Each webhook is an HTTP POST with{" "}
            <code>Content-Type: application/json</code>. Here is an example
            payload for a paid listing booking:
          </p>
          <pre>
            <code>{WEBHOOK_EXAMPLE_JSON}</code>
          </pre>
          <p>
            Prices are in the smallest currency unit (e.g. pence for GBP, cents
            for USD). The <code>ticket_url</code> links to the attendee's ticket
            page. For multi-listing bookings the <code>tickets</code> array
            contains one entry per listing, all sharing the same ticket token.
          </p>
        </Q>
      </Section>

      <Section id="login" title="Login &amp; Sessions">
        <Q q="What are sessions?">
          <p>
            A session is created each time an admin logs in. Sessions expire
            after 24 hours. You can view all active sessions from the{" "}
            <strong>Sessions</strong> page.
          </p>
        </Q>

        <Q q="What happens when I change my password?">
          <p>
            Changing your password <strong>ends every active session</strong>{" "}
            for your account &mdash; you and anyone else signed in as you will
            be logged out and must sign in again with the new password.
          </p>
          <p>
            Your existing attendee data remains fully accessible. The encryption
            key is re-secured with the new password, so every record created
            before the change can still be decrypted after you log back in.
          </p>
        </Q>

        <Faq id="how_do_i_log_out_other_users" />

        <Q q="What happens after too many failed login attempts?">
          <p>
            The login form is protected by per-IP rate limiting. After{" "}
            <strong>{MAX_LOGIN_ATTEMPTS} failed attempts</strong> from the same
            IP address, further login attempts from that IP are blocked for{" "}
            <strong>{LOGIN_LOCKOUT_MS / 60_000} minutes</strong>. A successful
            login clears the counter immediately. This defends against password
            guessing and credential stuffing.
          </p>
          <p>
            If you&apos;re legitimately locked out, wait for the lockout to
            expire or log in from a different network. Because there is{" "}
            <strong>no password recovery</strong> (see{" "}
            <strong>Data &amp; Privacy</strong>), another owner cannot unlock
            your account &mdash; only time (or switching IP) will clear the
            block.
          </p>
        </Q>
      </Section>

      <Section id="calendar" title={t("guide.sections.calendar")}>
        <Faq id="what_is_calendar" />
      </Section>

      <Section id="activity-log" title={t("guide.sections.activity_log")}>
        <Faq id="what_is_activity_log" />
      </Section>

      <Section id="email" title={t("guide.sections.email_notifications")}>
        <Faq id="what_are_email_notifications" />

        <Faq id="supported_email_providers" />

        <Q q={t("guide.q.setup_email")}>
          {hostConfig?.hostEmailProvider && (
            <p>
              Email is already configured by your server administrator using{" "}
              <strong>{hostConfig.hostEmailProvider}</strong> with from address{" "}
              <code>{hostConfig.hostEmailFromAddress}</code>. You can override
              this by entering your own provider and API key in{" "}
              <a href="/admin/settings">Settings</a>. If you provide your own
              settings, they take priority over the server configuration.
            </p>
          )}
          <ol>
            <li>
              Go to <a href="/admin/settings">Settings</a> and find the{" "}
              <strong>Email</strong> section
            </li>
            <li>Choose your email provider from the dropdown</li>
            <li>
              Paste your provider's API key into the <strong>API Key</strong>{" "}
              field
            </li>
            <li>
              Enter a <strong>From Address</strong> &mdash; this is the sender
              address that appears on outgoing emails. If left blank, the
              business email address is used instead
            </li>
            <li>Save the settings</li>
          </ol>
          <p>
            The from address must be a verified sender in your email provider's
            account, otherwise emails will be rejected. Check your provider's
            documentation for how to verify a sender domain or address.
          </p>
        </Q>

        <Q q={t("guide.q.test_email_working")}>
          <p>
            After saving your email settings, a <strong>Send Test Email</strong>{" "}
            button appears. Click it to send a test email to your business email
            address. If the test fails, you'll see an error with the HTTP status
            code from your provider &mdash; check that your API key is correct
            and your from address is verified.
          </p>
        </Q>

        <Faq id="email_not_configured" />

        <Q q={t("guide.q.confirmation_email_content")}>
          <p>
            The attendee receives an email with the listing name(s), quantity,
            price paid, and a clickable link to their ticket page. Each email
            also includes an SVG ticket image as an attachment &mdash; one per
            listing, with a QR code for check-in. For{" "}
            <strong>Purchase Only</strong> listings the QR code is omitted since
            there is no check-in. For multi-listing bookings, all listings are
            listed in a single email with numbered ticket attachments. The
            business email is set as the reply-to address so attendees can reply
            directly to you.
          </p>
        </Q>

        <Faq id="admin_notification_email_content" />
      </Section>

      <Section id="email-templates" title={t("guide.sections.email_templates")}>
        <Q q={t("guide.q.customise_emails")}>
          <p>
            Yes. In <a href="/admin/settings">Settings</a>, scroll to the email
            template sections. You can customise both the{" "}
            <strong>confirmation email</strong> (sent to the attendee) and the{" "}
            <strong>admin notification email</strong> (sent to you). Each has
            three parts: subject line, HTML body, and plain text body.
          </p>
          <p>
            Templates use <a href="https://liquidjs.com/">Liquid</a> syntax.
            Clear any field to revert to the built-in default.
          </p>
        </Q>

        <Q q={t("guide.q.template_variables")}>
          <ul>
            <li>
              <code>{"{{ listing_names }}"}</code> &mdash; all listing names
              joined with &ldquo;and&rdquo;
            </li>
            <li>
              <code>{"{{ ticket_url }}"}</code> &mdash; link to view tickets
            </li>
            <li>
              <code>{"{{ currency }}"}</code> &mdash; currency code (e.g. GBP)
            </li>
            <li>
              <code>{"{{ attendee.name }}"}</code>,{" "}
              <code>{"{{ attendee.email }}"}</code>,{" "}
              <code>{"{{ attendee.phone }}"}</code>,{" "}
              <code>{"{{ attendee.address }}"}</code>,{" "}
              <code>{"{{ attendee.special_instructions }}"}</code>
            </li>
            <li>
              <code>{"{{ attendee.quantity }}"}</code>,{" "}
              <code>{"{{ attendee.price_paid }}"}</code>,{" "}
              <code>{"{{ attendee.date }}"}</code>
            </li>
          </ul>
          <p>
            For multi-listing bookings, loop through the <code>entries</code>{" "}
            array: <code>{"{% for entry in entries %}"}</code>. Each entry has{" "}
            <code>entry.listing.name</code>,{" "}
            <code>entry.attendee.quantity</code>,{" "}
            <code>entry.attendee.date</code>, etc. The quantity and date are
            per-listing &mdash; each entry shows the values for that specific
            listing registration.
          </p>
        </Q>

        <Q q={t("guide.q.template_filters")}>
          <p>Two custom filters are built in:</p>
          <ul>
            <li>
              <code>{"{{ amount | currency }}"}</code> &mdash; formats a number
              as currency (e.g. &pound;15.00)
            </li>
            <li>
              <code>{'{{ count | pluralize: "ticket", "tickets" }}'}</code>{" "}
              &mdash; returns the singular or plural form based on the count
            </li>
          </ul>
        </Q>

        <Faq id="template_error" />
      </Section>

      <Section id="bulk-email" title="Bulk Email">
        <Faq id="how_do_i_email_a_group_of" />

        <Faq id="who_can_i_send_to" />

        <Q q="Why do I need my own email provider to send?">
          <p>
            Bulk email sends through <strong>your own</strong> configured email
            provider, not any shared/host email. Sending marketing from a shared
            address would put every site on the platform at risk of being
            flagged as spam. If you haven't added your own provider (under{" "}
            <a href="/admin/settings-advanced">Advanced Settings</a> &rarr;{" "}
            <strong>Email Notifications</strong>), the Send button is disabled
            &mdash; but you can still use the BCC email-app option (see below).
          </p>
          <p>
            Bulk email goes out through your provider's batch API, so all
            supported providers (Resend, Postmark, SendGrid, and Mailgun) can
            send it.
          </p>
        </Q>

        <Q q="What's the difference between a marketing and a transactional email?">
          <p>
            A <strong>transactional</strong> (service) email is essential
            information about a listing someone booked &mdash; a venue change, a
            reminder, cancellation details. A <strong>marketing</strong> email
            promotes something &mdash; a new listing, an offer, a newsletter.
          </p>
          <p>
            When you tick <strong>marketing</strong>, every email gets an{" "}
            <strong>unsubscribe footer</strong>, and anyone who has previously
            unsubscribed is skipped automatically. Transactional emails get no
            footer and reach everyone. Only mark genuine promotions as marketing
            &mdash; mislabelling promotions as transactional to dodge the
            unsubscribe rules can breach anti-spam laws (such as GDPR/PECR or
            CAN-SPAM).
          </p>
        </Q>

        <Faq id="how_does_unsubscribing_work" />

        <Faq id="what_is_the_bcc_email_app_option" />

        <Q q="Can I see how often I've contacted someone?">
          <p>
            Yes. Each attendee's page shows an <strong>Email History</strong>{" "}
            &mdash; how many bulk emails they've received, when they were last
            contacted, and the last subject &mdash; so you can avoid
            over-emailing. When you preview a bulk email, a line summarises how
            often that audience has been contacted on average, so you get a
            sense of the group before you send.
          </p>
          <p>
            Counts cover bulk emails only (not per-booking confirmations) and
            are tracked against a one-way hash of the address, so the history
            follows the person even across separate bookings.
          </p>
        </Q>
      </Section>

      <Section id="host-subdomain" title="Host Subdomain">
        <Q q="What is a host subdomain?">
          <p>
            If your server administrator has enabled subdomain registration, you
            can claim a pretty subdomain for your tickets site (e.g.{" "}
            <code>
              my-business
              {hostConfig?.bunnyDnsSubdomainSuffix || ".example.com"}
            </code>
            ) instead of using the default CDN hostname. The option appears in{" "}
            <strong>Advanced Settings</strong> under{" "}
            <strong>Host Subdomain</strong>.
          </p>
        </Q>

        <Q q="How do I register a subdomain?">
          <ol>
            <li>
              Go to <a href="/admin/settings-advanced">Advanced Settings</a> and
              find the <strong>Host Subdomain</strong> section
            </li>
            <li>
              Enter your preferred subdomain name (lowercase letters, numbers,
              and hyphens only)
            </li>
            <li>
              Click{" "}
              <strong>Check Availability &amp; Preview Complete Domain</strong>{" "}
              to see the full URL and verify it's available
            </li>
            <li>
              If it looks right, tick the confirmation checkbox and click{" "}
              <strong>Register Subdomain</strong>
            </li>
          </ol>
          <p>
            <strong>Important:</strong> Once registered, a subdomain is{" "}
            <strong>permanent and cannot be changed</strong>. DNS, SSL, and CDN
            configuration are handled automatically.
          </p>
        </Q>

        <Faq id="can_i_use_both_a_subdomain_and" />
      </Section>

      <Section id="custom-domain" title={t("guide.sections.custom_domain")}>
        <Q q={t("guide.q.setup_custom_domain")}>
          <p>
            If your site runs on Bunny CDN and the <code>BUNNY_API_KEY</code>{" "}
            and <code>BUNNY_SCRIPT_ID</code> environment variables are
            configured, you'll see a <strong>Custom Domain</strong> section in{" "}
            <a href="/admin/settings-advanced">Advanced Settings</a>. Enter your
            domain (e.g. <code>tickets.yourdomain.com</code>) and save, then
            follow the CNAME instructions shown and click{" "}
            <strong>Validate</strong>.
          </p>
        </Q>

        <Faq id="what_does_validation_do" />

        <Q q="What if validation fails?">
          <p>
            Validation is attempted automatically when you save your domain. If
            it fails &mdash; usually because DNS hasn't propagated yet &mdash;
            your domain is still saved and you'll see a warning. Create the
            CNAME record shown on the page, wait a few minutes for DNS to
            propagate, then click <strong>Validate Custom Domain</strong> to try
            again.
          </p>
          <p>
            Until validation succeeds, ticket links, redirect URLs, and emails
            continue to use your host subdomain (or the Bunny.net address if you
            haven't registered one). See{" "}
            <strong>Which domain is used for ticket links and emails?</strong>{" "}
            below.
          </p>
        </Q>

        <Q q="Which domain is used for ticket links and emails?">
          <p>
            The system picks a single <strong>canonical</strong> domain for
            every request and uses it for generated URLs (ticket links, QR
            codes, redirects, webhook callbacks, and emails). It's chosen in
            this order of priority:
          </p>
          <ol>
            <li>
              Your <strong>custom domain</strong>, but only once its{" "}
              <strong>CNAME has been validated</strong>. Saving a domain is not
              enough on its own.
            </li>
            <li>
              Your registered <strong>host subdomain</strong> (e.g.{" "}
              <code>mysite.tickets</code>), if one is set.
            </li>
            <li>
              Otherwise the hostname from the incoming request (the Bunny.net
              address).
            </li>
          </ol>
          <p>
            Both the host subdomain and a validated custom domain continue to
            accept traffic at the CDN level, but only the higher-priority one is
            used when the system generates links.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.settings_overview")}>
        <Faq id="available_settings" />

        <Q q="How does the header image work?">
          <p>
            Upload a logo or banner from <strong>Settings</strong> and it
            appears at the top of every admin and public page. The image is
            encrypted and served through the <code>/image/</code> proxy with
            long-lived immutable cache headers, so browsers only download it
            once.
          </p>
          <p>
            Supported formats are JPEG, PNG, GIF, and WebP, up to 256&nbsp;KB.
            Uploading a new image automatically deletes the old one, and the{" "}
            <strong>Remove Image</strong> button clears it completely. If image
            storage isn't configured the section is hidden &mdash; see{" "}
            <strong>Advanced Settings</strong> to set up a Bunny storage zone.
          </p>
        </Q>

        <Q q={t("guide.q.advanced_settings")}>
          <p>
            The main Settings page has a link to{" "}
            <strong>Advanced Settings</strong> for less common configuration.
            Advanced settings include:
          </p>
          <ul>
            <li>
              <strong>Public API</strong> &mdash; enable the JSON API for
              external integrations
            </li>
            <li>
              <strong>Apple Wallet</strong> &mdash; configure pass signing
              certificates for Add to Apple Wallet
            </li>
            <li>
              <strong>Google Wallet</strong> &mdash; configure service account
              credentials for Add to Google Wallet
            </li>
            <li>
              <strong>Email provider</strong> &mdash; choose and configure your
              email sending service
            </li>
            <li>
              <strong>Email templates</strong> &mdash; customise confirmation
              and admin notification emails using Liquid syntax
            </li>
            <li>
              <strong>Host subdomain</strong> &mdash; register a pretty
              subdomain for your site (when enabled by server administrator)
            </li>
            <li>
              <strong>Custom domain</strong> &mdash; set up a custom domain for
              your site (Bunny CDN only)
            </li>
            <li>
              <strong>Backups</strong> &mdash; create, download, and restore
              full database backups (requires CDN storage)
            </li>
            <li>
              <strong>Software updates</strong> &mdash; check for and install
              new versions
            </li>
            <li>
              <strong>Database reset</strong> &mdash; permanently delete all
              data
            </li>
          </ul>
        </Q>

        <Faq id="what_is_debug_page" />

        <Faq id="what_is_the_debug_footer" />
      </Section>

      {hostConfig?.builderEnabled && (
        <Section id="built-sites" title="Built Sites">
          <Faq id="what_are_built_sites" />

          <Faq id="how_do_i_create_a_new_tickets" />

          <Q q="What do I need before building a site?">
            <p>
              You need a libsql database (e.g. from{" "}
              <a href="https://turso.tech">Turso</a>) with its URL and auth
              token. The server must have <code>BUNNY_API_KEY</code> configured.
              The builder is owner-only.
            </p>
          </Q>

          <Q q="Can I add a site record without using the builder?">
            <p>
              Yes. On the <strong>Built Sites</strong> page, click{" "}
              <strong>Add Built Site</strong> to manually record a site name and
              URL. This is useful for tracking instances you deployed by other
              means.
            </p>
          </Q>
        </Section>
      )}

      <Section title={t("guide.sections.feeds_and_mobilizon")}>
        <Q q={t("guide.q.listing_feeds")}>
          <p>
            When the public site is enabled, two machine-readable feeds are
            available:
          </p>
          <ul>
            <li>
              <strong>ICS calendar</strong> &mdash;{" "}
              <code>/feeds/listings.ics</code> &mdash; subscribe from any
              calendar app (Google Calendar, Apple Calendar, Thunderbird, etc.)
            </li>
            <li>
              <strong>RSS feed</strong> &mdash; <code>/feeds/listings.rss</code>{" "}
              &mdash; subscribe from any RSS reader
            </li>
          </ul>
          <p>
            Both feeds include all active, non-hidden listings with open
            registration. Hidden listings are excluded. They update
            automatically as you add, change, or close listings.
          </p>
        </Q>

        <Q q={t("guide.q.connect_to_mobilizon")}>
          <p>
            <a href="https://mobilizon.org/">Mobilizon</a> is a federated events
            platform. You can use its built-in importer to pull listings from
            your ICS feed:
          </p>
          <ol>
            <li>
              On your Mobilizon instance, go to the event import tool (or use
              the public importer at{" "}
              <a href="https://import.mobilizon.fr/">import.mobilizon.fr</a>)
            </li>
            <li>
              Enter your ICS feed URL:{" "}
              <code>https://{getEffectiveDomain()}/feeds/listings.ics</code>
            </li>
            <li>
              Set <strong>joinMode</strong> to <strong>external</strong> so the
              &ldquo;Join&rdquo; button on Mobilizon links back to your
              registration page
            </li>
          </ol>
          <p>
            Listings will appear on Mobilizon and federate across the Fediverse.
            Users click through to your site to register and pay.
          </p>
        </Q>
      </Section>

      <Section id="api" title={t("guide.sections.public_api")}>
        <Faq id="what_is_public_api" />

        <Q q={t("guide.q.available_endpoints")}>
          <p>
            The base URL is your domain (e.g.{" "}
            <code>https://{getEffectiveDomain()}</code>). All responses are
            JSON.
          </p>
          <ul>
            <li>
              <code>GET /api/listings</code> &mdash; list all active, non-hidden
              listings
            </li>
            <li>
              <code>GET /api/listings/:slug</code> &mdash; get a single listing
              by its slug (hidden listings are accessible if you know the slug)
            </li>
            <li>
              <code>
                GET
                /api/listings/:slug/availability?quantity=N&amp;date=YYYY-MM-DD
              </code>{" "}
              &mdash; check if spots are available
            </li>
            <li>
              <code>POST /api/listings/:slug/book</code> &mdash; create a
              booking
            </li>
          </ul>
          <p>
            All endpoints support CORS, so you can call them from any website.
            <code>OPTIONS</code> preflight requests are handled automatically.
          </p>
        </Q>

        <Q q={t("guide.q.list_listings_api")}>
          <pre>
            <code>{`GET /api/listings\n\nResponse:\n${API_LIST_EXAMPLE_JSON}`}</code>
          </pre>
          <p>
            Prices are in the smallest currency unit (e.g. pence for GBP, cents
            for USD). <code>maxPurchasable</code> is 0 when the listing is sold
            out or registration is closed.
          </p>
        </Q>

        <Q q={t("guide.q.get_single_listing_api")}>
          <pre>
            <code>{`GET /api/listings/summer-workshop\n\nResponse:\n${API_SINGLE_EXAMPLE_JSON}`}</code>
          </pre>
          <p>
            The <code>availableDates</code> field is only included for daily
            listings. Returns <code>{'{ "error": "Listing not found" }'}</code>{" "}
            with status 404 if the listing doesn&apos;t exist or is inactive.
          </p>
        </Q>

        <Q q={t("guide.q.check_availability_api")}>
          <pre>
            <code>{`GET /api/listings/summer-workshop/availability?quantity=2\n\nResponse:\n${API_AVAILABILITY_EXAMPLE_JSON}`}</code>
          </pre>
          <p>
            For daily listings, add <code>&amp;date=YYYY-MM-DD</code> to check a
            specific date. The <code>quantity</code> parameter defaults to 1.
          </p>
        </Q>

        <Q q={t("guide.q.create_booking_api")}>
          <pre>
            <code>{`POST /api/listings/summer-workshop/book\nContent-Type: application/json\n\n${API_BOOK_REQUEST_JSON}`}</code>
          </pre>
          <p>
            Which fields are required depends on the listing's field settings.
            The <code>name</code> field is always required. <code>date</code> is
            required for daily listings (use a date from{" "}
            <code>availableDates</code>). <code>customPrice</code> is for
            pay-more listings only (in major currency units, e.g. 10.00 for
            &pound;10).
          </p>
          <p>
            <strong>Free listing response:</strong>
          </p>
          <pre>
            <code>{API_BOOK_FREE_EXAMPLE_JSON}</code>
          </pre>
          <p>
            <strong>Paid listing response:</strong>
          </p>
          <pre>
            <code>{API_BOOK_PAID_EXAMPLE_JSON}</code>
          </pre>
          <p>
            Redirect the user to <code>checkoutUrl</code> to complete payment.
            Possible error responses: 400 (validation error or registration
            closed), 404 (listing not found), 409 (not enough spots available).
          </p>
        </Q>

        <Q q={t("guide.q.api_data_exposure")}>
          <p>
            The API exposes <strong>exactly the same data</strong> as the public
            booking pages &mdash; no more. Internal fields like capacity limits,
            attendee counts, close times, and webhook URLs are never included.
            The <code>isSoldOut</code>, <code>isClosed</code>, and{" "}
            <code>maxPurchasable</code> fields are derived values, not raw
            database fields.
          </p>
        </Q>

        <Faq id="where_can_i_find_the_full_api" />
      </Section>

      <Section id="admin-api" title="Admin API">
        <Faq id="what_is_the_admin_api" />

        <Q q="How do I create an API key?">
          <p>
            Open <a href="/admin/api-keys">API Keys</a> (under{" "}
            <strong>Users</strong> in the navigation), enter a descriptive name
            for the key (e.g. "CI pipeline" or "Zapier integration"), and click{" "}
            <strong>Create key</strong>.
          </p>
          <p>
            <strong>The full key is shown only once.</strong> Copy it
            immediately and store it somewhere secure &mdash; once you leave the
            page there is no way to retrieve it again. If you lose a key, delete
            it and create a new one.
          </p>
        </Q>

        <Q q="How do I authenticate?">
          <p>
            Send the key in the <code>Authorization</code> header on every
            request:
          </p>
          <pre>
            <code>Authorization: Bearer YOUR_API_KEY</code>
          </pre>
          <p>
            Bearer-authenticated requests do not need a CSRF token. Send JSON
            request bodies with <code>Content-Type: application/json</code>.
            Requests without a valid key receive a{" "}
            <code>401 Invalid API key</code> response.
          </p>
        </Q>

        <Q q="What admin endpoints are available?">
          <p>
            The admin API covers listings, groups, and holidays. Each resource
            supports list, get, create, update, and delete:
          </p>
          <ul>
            <li>
              <code>GET /api/admin/listings</code>,{" "}
              <code>POST /api/admin/listings</code>,{" "}
              <code>GET /api/admin/listings/:id</code>,{" "}
              <code>PUT /api/admin/listings/:id</code>,{" "}
              <code>DELETE /api/admin/listings/:id</code>,{" "}
              <code>POST /api/admin/listings/:id/deactivate</code>,{" "}
              <code>POST /api/admin/listings/:id/reactivate</code>
            </li>
            <li>
              <code>GET /api/admin/groups</code>,{" "}
              <code>POST /api/admin/groups</code>,{" "}
              <code>GET /api/admin/groups/:id</code>,{" "}
              <code>PUT /api/admin/groups/:id</code>,{" "}
              <code>DELETE /api/admin/groups/:id</code>
            </li>
            <li>
              <code>GET /api/admin/holidays</code>,{" "}
              <code>POST /api/admin/holidays</code>,{" "}
              <code>GET /api/admin/holidays/:id</code>,{" "}
              <code>PUT /api/admin/holidays/:id</code>,{" "}
              <code>DELETE /api/admin/holidays/:id</code>
            </li>
          </ul>
          <p>
            Delete requests must include a <code>confirm_identifier</code> field
            that matches the resource name &mdash; the same way the web UI
            requires you to type the name to confirm a delete. The{" "}
            <a href="/admin/api-keys/docs">API documentation page</a> shows the
            full request and response shape for every endpoint.
          </p>
        </Q>

        <Q q="How do I revoke an API key?">
          <p>
            Open <a href="/admin/api-keys">API Keys</a>, find the key in the
            list, and click <strong>Delete</strong>. You'll be asked to type the
            key's name to confirm. Revocation is immediate &mdash; any
            integration using that key will start receiving{" "}
            <code>401 Invalid API key</code> on its next request, so switch
            integrations over to a new key before deleting the old one.
          </p>
          <p>
            The <strong>Last used</strong> column on the API Keys page shows
            when each key was most recently accepted. Use it to spot keys that
            are no longer in use before deleting them.
          </p>
        </Q>

        <Faq id="what_happens_to_api_keys_if_their" />
      </Section>

      <Section id="backups" title="Backups">
        <Q q="What is the backup feature?">
          <p>
            The <strong>Backups</strong> page (owners only, under{" "}
            <a href="/admin/backup">Settings &rarr; Backups</a>) lets you create
            and restore full database backups. Each backup is a .zip archive
            containing SQL statements for every table. Backups are stored on
            your configured CDN storage (Bunny CDN).
          </p>
        </Q>

        <Q q="How do I create a backup?">
          <p>
            Go to <a href="/admin/backup">Backups</a> and click{" "}
            <strong>Create Backup Now</strong>. The system exports all database
            tables into a .zip file and uploads it to your storage. Previous
            backups are listed with their timestamps and can be downloaded at
            any time.
          </p>
        </Q>

        <Faq id="how_do_i_restore_from_a_backup" />

        <Faq id="are_old_backups_deleted_automatically" />

        <Q q="What is the encryption key shown on the backup page?">
          <p>
            The encryption key is needed if you ever restore a backup to a{" "}
            <strong>different</strong> site. All personal data in the database
            is encrypted at the field level, so you need the same encryption key
            to read it. Store this key securely &mdash; it cannot be recovered
            if lost.
          </p>
        </Q>

        <Faq id="do_backups_require_any_special_configuration" />
      </Section>

      <Section id="read-only-mode" title="Read-only Mode">
        <Faq id="why_does_my_site_say_it_s" />
      </Section>

      <Section title="Software Updates">
        <Faq id="how_do_i_check_for_updates" />

        <Faq id="what_does_the_version_number_mean" />

        <Q q="How do I install an update?">
          <p>
            If an update is available and your server has{" "}
            <code>BUNNY_API_KEY</code> and <code>BUNNY_SCRIPT_ID</code>{" "}
            configured, an <strong>Update Now</strong> button appears. Click it
            to download and deploy the new version automatically via Bunny CDN.
            The update is logged in the activity log. If the Bunny environment
            variables are not set, you'll need to deploy the update manually.
          </p>
        </Q>

        <Q q="Where can I read the release notes?">
          <p>
            The update page includes a link to the{" "}
            <a href="https://github.com/chobbledotcom/tickets/releases">
              release notes on GitHub
            </a>
            , where you can see what changed in each version before deciding to
            update.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.customising_your_site")}>
        <Q q={t("guide.q.customise_system")}>
          <p>
            Absolutely. This is open-source software, so you have full control.
            You can{" "}
            <a href="https://github.com/chobbledotcom/tickets">
              grab the code from GitHub
            </a>{" "}
            and host it yourself on Bunny Edge Scripting or any compatible
            platform. The README has deployment instructions to get you started.
          </p>
        </Q>

        <Q q={t("guide.q.customise_for_me")}>
          <p>
            Yes. I offer customisation at a transparent flat rate &mdash; see{" "}
            <a href="https://chobble.com/prices">chobble.com/prices</a> for
            current pricing. I can help you with custom features, branding,
            listing image design, hosting setup, or whatever you need. You'll
            own the code outright, and I can show you how to maintain it
            yourself or handle updates for you. Over 20 years building web
            systems means I can usually solve problems quickly and clearly.
          </p>
        </Q>

        <Faq id="hosting_and_images" />
      </Section>
      <Section id="column-order" title="Column Order">
        <Q q="How do I customise which columns appear in tables?">
          <p>
            Go to <strong>Advanced Settings</strong> and find the{" "}
            <strong>Listing Table Columns</strong> or{" "}
            <strong>Attendee Table Columns</strong> section. Enter a
            comma-separated list of Liquid-style tags to control which columns
            appear and in what order.
          </p>
          <p>
            For example, to show only the name and status on the listings table:
          </p>
          <pre>
            <code>{"{{name}}, {{status}}"}</code>
          </pre>
          <p>
            Leave the field empty or clear it to restore the default column
            order.
          </p>
        </Q>

        <Q q="What listing table columns are available?">
          <p>
            Default order:{" "}
            <code>{buildDefaultTemplate(LISTING_DEFAULT_ORDER)}</code>
          </p>
          <Raw html={columnReferenceTable(LISTING_TABLE_COLUMNS)} />
        </Q>

        <Q q="What attendee table columns are available?">
          <p>
            Default order:{" "}
            <code>{buildDefaultTemplate(ATTENDEE_DEFAULT_ORDER)}</code>
          </p>
          <p>
            Columns referencing absent data (e.g. <code>{"{{email}}"}</code>{" "}
            when no attendees have an email) are hidden automatically even when
            included in the template.
          </p>
          <Raw html={columnReferenceTable(ATTENDEE_TABLE_COLUMNS)} />
        </Q>

        <Q q="Can I use custom date or currency formatting?">
          <p>
            Yes. Date and price columns support Liquid filters. Add a pipe (
            <code>|</code>) after the column name followed by the filter:
          </p>
          <pre>
            <code>
              {'{{created | date: "%B %d, %Y"}}'}
              {"\n"}
              {'{{date | date: "%A %e %b"}}'}
              {"\n"}
              {"{{price | currency}}"}
            </code>
          </pre>
          <p>
            The <code>date</code> filter uses{" "}
            <a href="https://strftime.net/">strftime format codes</a>. Common
            codes:
          </p>
          <ul>
            <li>
              <code>%Y</code> full year, <code>%y</code> 2-digit year
            </li>
            <li>
              <code>%B</code> full month name, <code>%b</code> abbreviated
            </li>
            <li>
              <code>%d</code> zero-padded day, <code>%e</code> day without
              padding
            </li>
            <li>
              <code>%A</code> full weekday, <code>%a</code> abbreviated
            </li>
            <li>
              <code>%H</code> hour (24h), <code>%I</code> hour (12h),{" "}
              <code>%M</code> minutes
            </li>
          </ul>
          <p>
            The <code>currency</code> filter formats a number as your configured
            currency (e.g. <code>2500</code> &rarr; &pound;25.00).
          </p>
          <p>
            Columns without a <code>rawValue</code> (like name or email) ignore
            filters &mdash; they always render their default content.
          </p>
        </Q>
      </Section>
    </Layout>,
  );
