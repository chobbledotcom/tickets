/** The listing save rule for a subscription ticket. */

import * as v from "valibot";
import { saleProviderOrNull } from "#shared/config.ts";
import { t } from "#i18n";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { RecurringIntervalSchema } from "#shared/subscriptions/plan.ts";

/** A recurring price needs a frequency, and a frequency needs a price. The
 * buyer pays the ticket price on the first day, so that price must be above
 * zero. Only Stripe charges a plan, so a plan needs Stripe. */
export const recurringPlanError = (input: ListingInput): string | null => {
  const price = input.recurringPrice ?? 0;
  const interval = input.recurringInterval ?? "";
  if (price === 0 && interval === "") return null;
  if (!Number.isSafeInteger(price) || price <= 0) {
    return t("error.recurring_price_required");
  }
  if (!v.is(RecurringIntervalSchema, interval)) {
    return t("error.recurring_interval_required");
  }
  if (saleProviderOrNull() !== "stripe") {
    return t("error.recurring_needs_stripe");
  }
  return (input.unitPrice ?? 0) > 0
    ? null
    : t("error.recurring_needs_ticket_price");
};
