/* jscpd:ignore-start */
import { ErrorCode } from "#shared/logger.ts";
import { createWithClient } from "#shared/payment-helpers.ts";
import type { GetSquareClient } from "#shared/square/client.ts";
import { stringEntries } from "#shared/string-entries.ts";
/* jscpd:ignore-end */

/** The Square order facts used to rebuild a checkout session. */
export type SquareOrder = {
  id?: string | undefined;
  metadata?: Record<string, string> | undefined;
  tenders?:
    | Array<{
        id?: string | undefined;
        paymentId?: string | undefined;
      }>
    | undefined;
  state?: string | undefined;
  totalMoney: { amount: bigint | null; currency: string | null };
  createdAt?: string | undefined;
};

/** Retrieve and normalize one Square order. */
export const retrieveSquareOrder = (
  getClient: GetSquareClient,
  orderId: string,
): Promise<SquareOrder | null> =>
  createWithClient(getClient)(async (client) => {
    const { order } = await client.orders.get({ orderId });
    if (!order) return null;
    const metadata: Record<string, string> | undefined = order.metadata
      ? Object.fromEntries(stringEntries(Object.entries(order.metadata)))
      : undefined;
    return {
      createdAt: order.createdAt,
      id: order.id,
      metadata,
      state: order.state,
      tenders: order.tenders?.map((tender) => ({
        id: tender.id,
        paymentId: tender.paymentId ?? undefined,
      })),
      totalMoney: {
        amount: order.totalMoney?.amount ?? null,
        currency: order.totalMoney?.currency ?? null,
      },
    };
  }, ErrorCode.SQUARE_ORDER);
