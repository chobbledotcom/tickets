import { executeBatch } from "#shared/db/client.ts";
import {
  type BookingSource,
  orderActivityStatements,
} from "#shared/db/contact-tokens.ts";

/** Seed order activity through the same statements used by atomic booking. */
export const seedOrderActivity = async (
  email: unknown,
  phone: unknown,
  source: BookingSource,
  ticketToken: string,
): Promise<void> => {
  await executeBatch(
    await orderActivityStatements(email, phone, source, ticketToken),
  );
};
