/**
 * Apple Wallet pass download route - /wallet/:token
 * Generates and returns a .pkpass file for a single ticket token.
 * CDN-cacheable — passes are deterministic for a given token + settings.
 */

import { buildPkpass, type PassData } from "#lib/apple-wallet.ts";
import { getAllowedDomain } from "#lib/config.ts";
import { decrypt } from "#lib/crypto.ts";
import { getCurrencyCodeFromDb } from "#lib/db/settings.ts";
import { getAppleWalletConfig } from "#lib/db/settings.ts";
import { createTokenRoute, lookupAttendees, resolveEntries, type TokenEntry } from "#routes/token-utils.ts";
import { notFoundResponse } from "#routes/utils.ts";

/** Cache pkpass responses for 1 hour on CDN, 5 minutes in browser */
const CACHE_CONTROL = "public, max-age=300, s-maxage=3600";

/** MIME type for Apple Wallet passes */
const PKPASS_CONTENT_TYPE = "application/vnd.apple.pkpass";

/** Build PassData from a resolved token entry */
const buildPassData = async (entry: TokenEntry, token: string): Promise<PassData> => {
  const { event, attendee } = entry;
  const domain = getAllowedDomain();
  const currencyCode = await getCurrencyCodeFromDb();
  const pricePaid = Number(await decrypt(attendee.price_paid));

  return {
    serialNumber: token,
    organizationName: domain,
    description: `Ticket for ${event.name}`,
    eventName: event.name,
    eventDate: event.date,
    eventLocation: event.location,
    attendeeDate: attendee.date,
    quantity: attendee.quantity,
    pricePaid,
    currencyCode,
    checkinUrl: `https://${domain}/checkin/${token}`,
  };
};

/** Handle GET /wallet/:token — generate and return .pkpass */
const handleWalletGet = async (_request: Request, tokens: string[]): Promise<Response> => {
  // Only support single-token downloads
  const token = tokens[0];
  if (!token || tokens.length > 1) return notFoundResponse();

  const config = await getAppleWalletConfig();
  if (!config) return notFoundResponse();

  const result = await lookupAttendees([token]);
  if (!result.ok) return result.response;

  const entries = await resolveEntries(result.attendees);
  const passData = await buildPassData(entries[0]!, token);
  const pkpass = buildPkpass(passData, config);

  return new Response(pkpass as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": PKPASS_CONTENT_TYPE,
      "Content-Disposition": `inline; filename="ticket.pkpass"`,
      "Cache-Control": CACHE_CONTROL,
    },
  });
};

/** Route wallet pass requests */
export const routeWallet = createTokenRoute("wallet", { GET: handleWalletGet });
