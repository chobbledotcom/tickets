/** The Subscriptions page: every booking that started a Stripe subscription. */

import { t } from "#i18n";
import { isCancellable } from "#payment/subscription-machine-spec.ts";
import type { AuthSession } from "#routes/auth.ts";
import {
  adminDestinationAllowed,
  adminPath,
  adminRecordPath,
} from "#shared/admin-surface.ts";
import { formatCurrency } from "#shared/currency.ts";
import { isReadOnly } from "#shared/env.ts";
import type { FlashFields } from "#shared/flash-fields.ts";
import {
  RECURRING_CHARGE_KEYS,
  SUBSCRIPTION_STATUS_LABEL_KEYS,
} from "#shared/subscriptions/labels.ts";
import type {
  RecurringInterval,
  SubscriptionStatus,
} from "#shared/subscriptions/plan.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { renderAdminPageSpec } from "#templates/admin/admin-page-spec.tsx";
import { InlineFormButton } from "#templates/components/inline-form-button.tsx";
import { linkCell } from "#templates/components/link-cell.tsx";
import {
  labelColumn,
  translatedTableColumn,
} from "#templates/components/translated-table-column.ts";

/** One subscriber, with the names already decrypted. */
export type SubscriberRow = {
  attendeeId: number;
  bookingId: number;
  interval: RecurringInterval;
  name: string;
  price: number;
  status: SubscriptionStatus;
  stripeId: string;
  tax: number;
  ticket: string;
};

const subscriberTable = defineTable<SubscriberRow>([
  translatedTableColumn(
    "subscriber",
    "subscriptions.column.subscriber",
    linkCell(
      (row) => adminPath("attendee", { attendeeId: row.attendeeId }),
      (row) => row.name,
    ),
  ),
  translatedTableColumn(
    "ticket",
    "subscriptions.column.ticket",
    (row) => row.ticket,
  ),
  translatedTableColumn("charge", "subscriptions.column.charge", (row) =>
    t(RECURRING_CHARGE_KEYS[row.interval], {
      amount: formatCurrency(row.price),
    }),
  ),
  translatedTableColumn("tax", "subscriptions.column.tax", (row) =>
    formatCurrency(row.tax),
  ),
  labelColumn(
    "status",
    "subscriptions.column.status",
    SUBSCRIPTION_STATUS_LABEL_KEYS,
    (row) => row.status,
  ),
  translatedTableColumn(
    "stripe_id",
    "subscriptions.column.stripe_id",
    (row) => row.stripeId,
  ),
]);

/** A subscription that ended has nothing left to cancel. */
const cancelTable = defineTable<SubscriberRow>([
  ...subscriberTable.columns,
  translatedTableColumn("cancel", "subscriptions.column.cancel", (row) =>
    isCancellable(row.status) ? (
      <InlineFormButton
        action={adminRecordPath("subscriptionCancel", row.bookingId)}
      >
        {t("subscriptions.cancel.button")}
      </InlineFormButton>
    ) : (
      ""
    ),
  ),
]);

export const adminSubscriptionsPage = ({
  flash,
  session,
  subscribers,
}: {
  flash: FlashFields;
  session: AuthSession;
  subscribers: SubscriberRow[];
}): string => {
  const canCancel = adminDestinationAllowed(
    "subscriptionCancel",
    session.adminLevel,
    isReadOnly(),
  );
  return renderAdminPageSpec({
    active: "/admin/subscriptions",
    flash,
    list: {
      columns: (canCancel ? cancelTable : subscriberTable).columns,
      empty: t("subscriptions.empty"),
      intro: (
        <>
          <p class="prose">{t("subscriptions.intro")}</p>
          {canCancel ? (
            <p class="prose">{t("subscriptions.cancel.warning")}</p>
          ) : (
            ""
          )}
        </>
      ),
      items: subscribers,
    },
    session,
    title: t("subscriptions.title"),
  });
};
