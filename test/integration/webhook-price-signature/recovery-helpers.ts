import { expect } from "@std/expect";
import { legReference } from "#shared/accounting/refs.ts";
import { queryOne } from "#shared/db/client.ts";
import { hashEmail, hashPhone } from "#shared/db/contact-preferences.ts";
import { getRecentBookingTokens } from "#shared/db/contact-tokens.ts";

const contactCountsByHash = (hash: string) =>
  queryOne<{ public_booking_count: number; visits: number }>(
    `SELECT public_booking_count, visits FROM contact_preferences
     WHERE contact_hash = ?`,
    [hash],
  );

export const contactCounts = async (
  email: string,
): Promise<{ public_booking_count: number; visits: number } | null> =>
  contactCountsByHash(await hashEmail(email));

export const expectedBookingReferences = async (
  sessionId: string,
  listingId: number,
  modifierId: number,
): Promise<string[]> =>
  Promise.all([
    legReference(["booking", sessionId, "sale", listingId]),
    legReference(["booking", sessionId, "mod", modifierId]),
    legReference(["booking", sessionId, "payment"]),
  ]);

export const expectContactActivity = async (
  email: string,
  phone: string,
  privateKey: CryptoKey,
  ticketToken: string,
): Promise<void> => {
  const expectedCounts = { public_booking_count: 1, visits: 1 };
  expect(await contactCountsByHash(await hashEmail(email))).toEqual(
    expectedCounts,
  );
  expect(await contactCountsByHash(await hashPhone(phone))).toEqual(
    expectedCounts,
  );
  const expectedTokens = [{ source: "public" as const, token: ticketToken }];
  expect(
    await getRecentBookingTokens(await hashEmail(email), privateKey, 10),
  ).toEqual(expectedTokens);
  expect(
    await getRecentBookingTokens(await hashPhone(phone), privateKey, 10),
  ).toEqual(expectedTokens);
};
