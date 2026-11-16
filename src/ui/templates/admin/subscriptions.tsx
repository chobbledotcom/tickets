/** The Subscriptions page: every booking that started a Stripe subscription. */

import { t } from "#i18n";
import type { AuthSession } from "#routes/auth.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { formatCurrency } from "#shared/currency.ts";
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
import { linkCell } from "#templates/components/link-cell.tsx";
import {
  labelColumn,
  translatedTableColumn,
} from "#templates/components/translated-table-column.ts";

/** One subscriber, with the names already decrypted. */
export type SubscriberRow = {
  attendeeId: number;
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

export const adminSubscriptionsPage = ({
  flash,
  session,
  subscribers,
}: {
  flash: FlashFields;
  session: AuthSession;
  subscribers: SubscriberRow[];
}): string =>
  renderAdminPageSpec({
    active: "/admin/subscriptions",
    flash,
    list: {
      columns: subscriberTable.columns,
      empty: t("subscriptions.empty"),
      intro: <p class="prose">{t("subscriptions.intro")}</p>,
      items: subscribers,
    },
    session,
    title: t("subscriptions.title"),
  });
