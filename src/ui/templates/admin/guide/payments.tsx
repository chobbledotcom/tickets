/**
 * Admin guide — Payments sections.
 */

import { t } from "#i18n";
/* jscpd:ignore-start -- imports */
import { formatCurrency } from "#shared/currency.ts";
import { durationWords } from "#shared/format-units.ts";
import { CHECKOUT_WINDOW_MINUTES } from "#shared/limits.ts";
import {
  custom,
  faq,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";
/* jscpd:ignore-end */
import { MAX_DURATION_DAYS } from "#types";

export const paymentsSections = (): GuideSection[] => [
  {
    entries: [
      faq("supported_payment_providers"),
      faq("recommended_payment_provider"),
      faq("paid_ticket_booking_flow"),
      faq("why_don_t_we_hold_places_during"),
      faq("listing_sells_out_while_paying"),
      custom(
        "checkout_window",
        <>
          <p>
            An unpaid checkout can take payment for{" "}
            {durationWords(CHECKOUT_WINDOW_MINUTES * 60)}{" "}
            after it starts. After that time, the checkout is closed and the
            buyer must book again.
          </p>
          <p>
            Stripe and Square both close the checkout at the end of that time:
            the site closes a Square payment link itself, and Stripe closes its
            checkout page. A SumUp checkout always closes after 30 minutes.
          </p>
        </>,
      ),
      faq("how_refunds_work"),
      custom(
        "what_is_booking_fee",
        <>
          <p>
            The booking fee is an extra percentage you can add to ticket prices
            at checkout. For example, a 2% booking fee on a{" "}
            {formatCurrency(1000)} ticket means the attendee pays{" "}
            {formatCurrency(1020)} in total.
          </p>
          <p>
            Set it in <a href="/admin/settings">Settings</a> under{" "}
            <strong>Booking Fee</strong>. The section appears only when a
            payment company is set up. Enter a percentage from 0 to 10. Set it
            to 0 or leave it blank to switch the fee off. The fee is added
            automatically at checkout.
          </p>
        </>,
      ),
    ],
    titleKey: "payments",
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
    titleKey: "payment_setup",
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
    titleKey: "refunds",
  },
  {
    entries: [
      faq("what_is_the_money_ledger"),
      faq("ledger_accounts_explained"),
      faq("ledger_entry_kinds"),
      faq("ledger_manual_entries"),
    ],
    id: "ledger",
    titleKey: "ledger",
  },
  {
    entries: [
      faq("how_daily_listings_work"),
      faq("what_are_bookable_days"),
      custom(
        "booking_duration_field",
        <>
          <p>
            For daily listings,{" "}
            <strong>{t("fields.listing.duration_days")}</strong>{" "}
            sets how many days in a row one booking covers — handy for
            multi-night stays or multi-day passes. Leave it at 1 for a normal
            single-day booking, or set it up to {MAX_DURATION_DAYS}{" "}
            days. The attendee picks a start date, and their booking runs that
            many days from it.
          </p>
          <p>
            Every day the booking covers must have room, or the booking cannot
            be made. On the ticket and in the attendee table, the booking shows
            as a date range instead of a single day. The field appears only on
            daily listings.
          </p>
          <p>
            If you change the duration on a listing that already has bookings,
            every existing booking's date range is worked out again. The site
            warns you before saving, because it can change how many places are
            left on each day.
          </p>
        </>,
      ),
      faq("what_are_holidays"),
    ],
    id: "holidays",
    titleKey: "daily_listings_and_holidays",
  },
];
