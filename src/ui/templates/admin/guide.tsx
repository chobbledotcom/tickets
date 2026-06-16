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
        <Faq id="create_listing" />

        <Faq id="setup_payments" />
      </Section>

      <Section title={t("guide.sections.dashboard")}>
        <Faq id="what_is_dashboard" />
      </Section>

      <Section title={t("guide.sections.testing_your_system")}>
        <Faq id="test_after_changing_settings" />

        <Faq id="report_bug" />
      </Section>

      <Section title={t("guide.sections.listings")}>
        <Faq id="standard_vs_daily_listings" />

        <Faq id="combine_multiple_listings" />

        <Faq id="what_are_groups" />

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

        <Faq id="embed_booking_form" />

        <Faq id="manually_add_attendee" />

        <Faq id="custom_redirect_after_booking" />

        <Faq id="add_listing_image" />

        <Faq id="add_file_attachment" />

        <Faq id="listing_qr_code" />

        <Faq id="duplicate_listing" />

        <Faq id="deactivate_listing" />

        <Faq id="non_transferable_tickets" />

        <Faq id="edit_attendee" />

        <Faq id="how_do_i_add_an_attendee_to" />

        <Faq id="how_do_i_remove_an_attendee_from" />

        <Faq id="how_do_i_delete_an_attendee" />

        <Faq id="how_do_i_merge_duplicate_attendees" />

        <Faq id="how_do_i_resend_a_confirmation_email" />

        <Faq id="add_terms_and_conditions" />
      </Section>

      <Section id="questions" title={t("guide.sections.booking_questions")}>
        <Faq id="what_are_custom_booking_questions" />

        <Faq id="create_question" />

        <Faq id="add_question_to_listing" />

        <Faq id="share_questions_between_listings" />

        <Faq id="where_to_see_answers" />
      </Section>

      <Section title={t("guide.sections.public_links")}>
        <Faq id="facebook_403_error" />
      </Section>

      <Section title={t("guide.sections.public_site")}>
        <Faq id="what_is_public_site" />

        <Faq id="hide_listing_from_public_list" />

        <Faq id="edit_homepage_and_contact" />
      </Section>

      <Section id="text-formatting" title={t("guide.sections.text_formatting")}>
        <Faq id="fields_support_formatting" />

        <Faq id="what_formatting_can_i_use" />
      </Section>

      <Section title={t("guide.sections.payments")}>
        <Faq id="supported_payment_providers" />

        <Faq id="recommended_payment_provider" />

        <Faq id="paid_ticket_booking_flow" />

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
        <Faq id="find_stripe_secret_key" />

        <Faq id="stripe_webhook_setup" />

        <Faq id="create_square_application" />

        <Faq id="find_square_access_token" />

        <Faq id="find_square_location_id" />

        <Faq id="setup_square_webhook" />

        <Faq id="how_do_i_set_up_sumup" />

        <Faq id="stripe_test_vs_live_keys" />

        <Faq id="test_or_live_credentials" />
      </Section>

      <Section id="refunds" title={t("guide.sections.refunds")}>
        <Faq id="automatic_refunds" />

        <Faq id="refund_individual_attendee" />

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

        <Faq id="use_qr_scanner" />

        <Faq id="scanner_no_checkout" />

        <Faq id="qr_different_listing" />

        <Faq id="scanner_status_messages" />

        <Faq id="what_if_someone_doesn_t_have_their" />

        <Faq id="how_do_i_filter_attendees_by_check" />
      </Section>

      <Section id="apple-wallet" title={t("guide.sections.apple_wallet")}>
        <Faq id="what_is_apple_wallet" />

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
        <Faq id="what_is_google_wallet_integration" />

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
        <Faq id="what_happens_if_i_enter_the_wrong" />

        <Faq id="why_am_i_locked_out_even_though" />

        <Faq id="is_there_a_way_to_recover_a" />

        <Faq id="how_are_admin_sessions_secured" />
      </Section>

      <Section title={t("guide.sections.data_and_privacy")}>
        <Faq id="attendee_data_protection" />

        <Faq id="lost_password" />

        <Faq id="export_attendee_data" />

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
        <Faq id="what_are_sessions" />

        <Faq id="what_happens_when_i_change_my_password" />

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

        <Faq id="test_email_working" />

        <Faq id="email_not_configured" />

        <Faq id="confirmation_email_content" />

        <Faq id="admin_notification_email_content" />
      </Section>

      <Section id="email-templates" title={t("guide.sections.email_templates")}>
        <Faq id="customise_emails" />

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

        <Faq id="why_do_i_need_my_own_email" />

        <Faq id="what_s_the_difference_between_a_marketing" />

        <Faq id="how_does_unsubscribing_work" />

        <Faq id="what_is_the_bcc_email_app_option" />

        <Faq id="can_i_see_how_often_i_ve" />
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

        <Faq id="how_do_i_register_a_subdomain" />

        <Faq id="can_i_use_both_a_subdomain_and" />
      </Section>

      <Section id="custom-domain" title={t("guide.sections.custom_domain")}>
        <Faq id="setup_custom_domain" />

        <Faq id="what_does_validation_do" />

        <Faq id="what_if_validation_fails" />

        <Faq id="which_domain_is_used_for_ticket_links" />
      </Section>

      <Section title={t("guide.sections.settings_overview")}>
        <Faq id="available_settings" />

        <Faq id="how_does_the_header_image_work" />

        <Faq id="advanced_settings" />

        <Faq id="what_is_debug_page" />

        <Faq id="what_is_the_debug_footer" />
      </Section>

      {hostConfig?.builderEnabled && (
        <Section id="built-sites" title="Built Sites">
          <Faq id="what_are_built_sites" />

          <Faq id="how_do_i_create_a_new_tickets" />

          <Faq id="what_do_i_need_before_building_a" />

          <Faq id="can_i_add_a_site_record_without" />
        </Section>
      )}

      <Section title={t("guide.sections.feeds_and_mobilizon")}>
        <Faq id="listing_feeds" />

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

        <Faq id="api_data_exposure" />

        <Faq id="where_can_i_find_the_full_api" />
      </Section>

      <Section id="admin-api" title="Admin API">
        <Faq id="what_is_the_admin_api" />

        <Faq id="how_do_i_create_an_api_key" />

        <Faq id="how_do_i_authenticate" />

        <Faq id="what_admin_endpoints_are_available" />

        <Faq id="how_do_i_revoke_an_api_key" />

        <Faq id="what_happens_to_api_keys_if_their" />
      </Section>

      <Section id="backups" title="Backups">
        <Faq id="what_is_the_backup_feature" />

        <Faq id="how_do_i_create_a_backup" />

        <Faq id="how_do_i_restore_from_a_backup" />

        <Faq id="are_old_backups_deleted_automatically" />

        <Faq id="what_is_the_encryption_key_shown_on" />

        <Faq id="do_backups_require_any_special_configuration" />
      </Section>

      <Section id="read-only-mode" title="Read-only Mode">
        <Faq id="why_does_my_site_say_it_s" />
      </Section>

      <Section title="Software Updates">
        <Faq id="how_do_i_check_for_updates" />

        <Faq id="what_does_the_version_number_mean" />

        <Faq id="how_do_i_install_an_update" />

        <Faq id="where_can_i_read_the_release_notes" />
      </Section>

      <Section title={t("guide.sections.customising_your_site")}>
        <Faq id="customise_system" />

        <Faq id="customise_for_me" />

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
