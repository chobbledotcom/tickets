/** The buyer-facing lines of one order: a package stays whole and concealed. */

import type { OrderLine } from "#db/attendees/balance.ts";
import { getPackageDisplaysByIds } from "#db/groups.ts";
import { flatMap, map, sumOf } from "#fp";
import type { LineItem } from "#shared/line-item.ts";
import {
  orderPackageRows,
  type PackageRowGroup,
} from "#shared/package-rows.ts";

/**
 * One order's lines as the buyer reads them. Rows booked through a package
 * collapse into one line named by the package, so no member listing name
 * reaches the buyer. A package row that is gone keeps `fallbackName`, because
 * a missing package grants no permission to name its members. The invoice body
 * and the public pay page both read an order this way.
 */
export const orderLineItems = async (
  lines: readonly OrderLine[],
  fallbackName: string,
): Promise<LineItem[]> => {
  const displays = await getPackageDisplaysByIds(
    map((line: OrderLine) => line.packageGroupId)([...lines]),
  );
  return flatMap((group: PackageRowGroup<OrderLine>) =>
    group.groupId === undefined
      ? map((row: OrderLine) => ({ name: row.name, quantity: row.quantity }))(
          group.rows,
        )
      : [
          {
            name: displays.get(group.groupId)?.name ?? fallbackName,
            quantity: sumOf((row: OrderLine) => row.quantity)(group.rows),
          },
        ],
  )(orderPackageRows(lines));
};
