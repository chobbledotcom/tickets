import { AsyncLocalStorage } from "node:async_hooks";
import { generateTicketToken } from "#shared/crypto/utils.ts";

const paymentTicketToken = new AsyncLocalStorage<string>();

/** Use one prepared random token throughout a paid booking's async write. */
export const withPaymentTicketToken = <T>(
  token: string,
  createBooking: () => Promise<T>,
): Promise<T> => paymentTicketToken.run(token, createBooking);

/** Return the prepared paid-booking token, failing if finalization escaped the
 * request scope that also supplied the attendee's encrypted token. */
export const currentPaymentTicketToken = (): string => {
  const current = paymentTicketToken.getStore();
  if (current === undefined) {
    throw new Error("Paid booking ticket token was not prepared");
  }
  return current;
};

/** Return the paid booking's prepared token, or a fresh token for every
 * independent free/admin/seed attendee creation. */
export const currentPaymentTicketTokenOrCreate = (): string => {
  const current = paymentTicketToken.getStore();
  if (current !== undefined) return current;
  return generateTicketToken();
};
