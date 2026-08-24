import type { ProviderRead } from "#payment/provider-read.ts";
import { judgedBy, refuseUnless } from "#payment/provider-resource-read.ts";
import type { GetSquareClient } from "#shared/square/client.ts";
import { readSquareResource } from "#shared/square/outcomes.ts";
import type { SquareOrder } from "#shared/square/wire.ts";

/** Read one Square order without confusing absence and failure. The answer is
 * already checked where it arrived, so only the order's own identity is left
 * to judge. */
export const readSquareOrder = (
  getClient: GetSquareClient,
  orderId: string,
): Promise<ProviderRead<SquareOrder>> =>
  readSquareResource(getClient)(
    async (square) => (await square.orders.get({ orderId })).order,
    judgedBy([
      refuseUnless(
        "mismatched_id",
        (order: SquareOrder) => order.id === orderId,
      ),
    ]),
  );
