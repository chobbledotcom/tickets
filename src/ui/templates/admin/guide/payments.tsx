/**
 * Admin guide — Payments sections.
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { MAX_DURATION_DAYS } from "#shared/types.ts";
import {
  custom,
  faq,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";

export const paymentsSections = (): GuideSection[] => [
  {
    entries: [
      faq("supported_payment_providers"),
      faq("recommended_payment_provider"),
      faq("paid_ticket_booking_flow"),
      faq("why_don_t_we_hold_places_during"),
      faq("listing_sells_out_while_paying"),
      faq("how_refunds_work"),
      custom(
        t("guide.q.what_is_booking_fee"),
        <>
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
        </>,
      ),
    ],
    title: t("guide.sections.payments"),
  },
  {
    entries: [
      faq("find_stripe_secret_key"),
      faq("stripe_webhook_setup"),
      faq("create_square_application"),
      faq("find_square_access_token"),
      faq("find_square_location_id"),
      faq("setup_square_webhook"),
      faq("how_do_i_set_up_sumup"),
      faq("stripe_test_vs_live_keys"),
      faq("test_or_live_credentials"),
    ],
    id: "payment-setup",
    title: t("guide.sections.payment_setup"),
  },
  {
    entries: [
      faq("automatic_refunds"),
      faq("refund_individual_attendee"),
      faq("refund_all_attendees"),
      faq("partial_refunds"),
      faq("is_the_booking_fee_refunded_too"),
      faq("attendee_after_refund"),
      faq("refund_free_listing"),
      faq("refund_fails"),
      faq("refund_same_attendee_twice"),
    ],
    id: "refunds",
    title: t("guide.sections.refunds"),
  },
  {
    entries: [
      faq("how_daily_listings_work"),
      faq("what_are_bookable_days"),
      custom(
        "What is the Booking Duration field?",
        <>
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
        </>,
      ),
      faq("what_are_holidays"),
    ],
    id: "holidays",
    title: t("guide.sections.daily_listings_and_holidays"),
  },
];
