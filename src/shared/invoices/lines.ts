/** Buyer-facing invoice lines, with packages kept whole. */

/* jscpd:ignore-start */
import type { OrderLine, OrderSummary } from "#db/attendees/balance.ts";
import { getPackageDisplaysByIds } from "#db/groups.ts";
import { map, sumOf } from "#fp";
import { t } from "#i18n";
import { orderPackageRows } from "#shared/package-rows.ts";
/* jscpd:ignore-end */

/** One invoice line: what the buyer booked, and how many. */
export type InvoiceLine = { name: string; quantity: number };

/**
 * The lines one invoice shows. Rows booked through a package collapse into one
 * line named by the package, the same way the balance page and the
 * confirmation email do it. No member listing name reaches the buyer. A
 * package row that is gone keeps the generic name, so its members stay
 * concealed.
 */
export const invoiceLines = async (
  summary: OrderSummary,
): Promise<InvoiceLine[]> => {
  const displays = await getPackageDisplaysByIds(
    summary.lines.map((line) => line.packageGroupId),
  );
  return orderPackageRows(summary.lines).flatMap((group) => {
    if (group.groupId === undefined) {
      return map((row: OrderLine) => ({
        name: row.name,
        quantity: row.quantity,
      }))(group.rows);
    }
    return [
      {
        name: displays.get(group.groupId)?.name ?? t("invoices.package"),
        quantity: sumOf((row: OrderLine) => row.quantity)(group.rows),
      },
    ];
  });
};
