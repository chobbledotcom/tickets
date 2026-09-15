import { t } from "#i18n";
import { countedText } from "#shared/count-text.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import { monthsPerUnitOf } from "#shared/purchase-unit.ts";

/** The name and one-unit description a provider checkout shows a priced line
 *  as. A line that counts months states the PER-UNIT term — the provider's
 *  quantity stays the number of units bought, so ×2 beside a "(3 Months)"
 *  plan shows quantity 2 with a "3 months" description — while a plain
 *  ticket line keeps its listing name with its count. */
export const providerLineCopy = (
  item: CheckoutItem,
  quantity: number,
): { description: string; name: string } => {
  const monthsEach = monthsPerUnitOf(item.purchaseUnit);
  return monthsEach === undefined
    ? {
        description: countedText(t("payment.provider.tickets"), quantity),
        name: t("payment.provider.ticket_name", { name: item.name }),
      }
    : {
        description: t("payment.provider.months", { count: monthsEach }),
        name: t("payment.provider.plan_name", { name: item.name }),
      };
};
