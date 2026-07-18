import { expect } from "@std/expect";
import { squarePaymentProvider } from "#shared/square-provider.ts";

export const expectUnpaidSquareSession = async (
  orderId: string,
  paymentReference: string,
): Promise<void> => {
  const result = await squarePaymentProvider.retrieveSession(orderId);
  expect(result).not.toBeNull();
  expect(result!.paymentStatus).toBe("unpaid");
  expect(result!.paymentReference).toBe(paymentReference);
};
