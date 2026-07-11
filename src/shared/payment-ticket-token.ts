import { AsyncLocalStorage } from "node:async_hooks";
import { generateTicketToken } from "#shared/crypto/utils.ts";

const paymentTicketToken = new AsyncLocalStorage<string>();

/** Use one pre-stored random token throughout a paid booking's async write. */
export const withPaymentTicketToken = <T>(
  token: string,
  createBooking: () => Promise<T>,
): Promise<T> => paymentTicketToken.run(token, createBooking);

/** Return the paid booking's pre-stored token, or a fresh token for every
 * independent free/admin/seed attendee creation. */
export const currentPaymentTicketTokenOrCreate = (): string => {
  const current = paymentTicketToken.getStore();
  if (current !== undefined) return current;
  return generateTicketToken();
};
