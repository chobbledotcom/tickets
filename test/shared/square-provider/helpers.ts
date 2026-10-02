/** Stubs shared by the Square provider read tests. */

import { stub } from "@std/testing/mock";
import type { ProviderRead } from "#payment/provider-read.ts";
import { squareApi } from "#shared/square/api.ts";
import type { SquarePayment } from "#shared/square/wire.ts";
import { SQUARE_ORDER_META, squareMoney } from "#test-utils/square/fixtures.ts";
import { squareOrderRead } from "#test-utils/square/outcomes.ts";

export const foundPayment = (
  resource: SquarePayment,
): ProviderRead<SquarePayment> => ({ resource, status: "found" });

/** A Square order in the given state with no tenders, and one payment read
 * that names itself: the shape the canceled-order and unreadable-payment
 * reads share. Runs the body with both stubs live, restoring them after. */
export const withOrderAndPayment = async (
  orderId: string,
  state: string,
  payment: SquarePayment,
  run: () => Promise<void>,
): Promise<void> => {
  const order = stub(squareApi, "readOrder", () =>
    Promise.resolve(
      squareOrderRead({
        id: orderId,
        metadata: SQUARE_ORDER_META,
        state,
        tenders: [],
        totalMoney: squareMoney(1000),
      }),
    ),
  );
  const read = stub(squareApi, "readPayment", () =>
    Promise.resolve(
      foundPayment({
        amountMoney: squareMoney(1000),
        ...payment,
      } as SquarePayment),
    ),
  );
  try {
    await run();
  } finally {
    order.restore();
    read.restore();
  }
};
