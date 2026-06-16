/**
 * Admin guide — Payments sections.
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { MAX_DURATION_DAYS } from "#shared/types.ts";
import { Faq, Q, Section } from "#templates/admin/guide/components.tsx";

export const Payments = (): JSX.Element => (
  <>
    <Section title={t("guide.sections.payments")}>
      <Faq id="supported_payment_providers" />

      <Faq id="recommended_payment_provider" />

      <Faq id="paid_ticket_booking_flow" />

      <Faq id="why_don_t_we_hold_places_during" />

      <Faq id="listing_sells_out_while_paying" />

      <Faq id="how_refunds_work" />

      <Q q={t("guide.q.what_is_booking_fee")}>
        <p>
          The booking fee is an optional percentage-based charge added to ticket
          prices at checkout. For example, if you set a 2% booking fee on a{" "}
          {formatCurrency(1000)} ticket, the attendee pays{" "}
          {formatCurrency(1020)} in total.
        </p>
        <p>
          Configure it in <a href="/admin/settings">Settings</a> under{" "}
          <strong>Booking Fee</strong> (only visible when a payment provider is
          set up). Enter a percentage between 0 and 10. Set it to 0 or leave it
          blank to disable. The fee is calculated on the subtotal and added
          automatically during checkout.
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
          For daily listings, <strong>Booking Duration (days)</strong> sets how
          many consecutive days a single booking reserves &mdash; useful for
          multi-night stays or multi-day passes. Leave it at 1 for a normal
          single-day booking, or set it up to {MAX_DURATION_DAYS} days. The
          attendee picks a start date and their booking spans that many days
          from it.
        </p>
        <p>
          Capacity is checked for <strong>every</strong> day the booking covers,
          so a place is only confirmed if all of those days have room. On the
          ticket and in the attendee table, the booking shows as a date range
          rather than a single day. The field only appears on daily listings
          &mdash; standard (one-off) listings don't use it.
        </p>
        <p>
          If you change the duration on a listing that already has bookings, the
          system recalculates the date range of every existing booking and warns
          you before saving, since this can affect how many places each day has
          left.
        </p>
      </Q>

      <Faq id="what_are_holidays" />
    </Section>
  </>
);
