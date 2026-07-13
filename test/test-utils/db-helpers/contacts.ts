import { recordBookingActivity } from "#shared/db/contact-tokens.ts";

/** Seed contact visits through the same atomic activity write production uses. */
export const seedContactVisits = async (
  hash: string,
  count = 1,
): Promise<void> => {
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      recordBookingActivity(hash, "public", `test-visit-${index}`),
    ),
  );
};
