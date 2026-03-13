/**
 * Google Wallet pass route - /gwallet/:token
 * Generates a signed JWT and redirects to the Google Wallet save URL.
 */

import { getAllowedDomain } from "#lib/config.ts";
import { decrypt } from "#lib/crypto.ts";
import {
  getCurrencyCodeFromDb,
  getGoogleWalletConfig,
} from "#lib/db/settings.ts";
import {
  buildGoogleWalletUrl,
  type GooglePassData,
} from "#lib/google-wallet.ts";
import {
  createTokenRoute,
  lookupAttendees,
  resolveEntries,
  type TokenEntry,
} from "#routes/token-utils.ts";
import { notFoundResponse } from "#routes/utils.ts";

/** Cache redirect responses for 1 hour on CDN, 5 minutes in browser */
const CACHE_CONTROL = "public, max-age=300, s-maxage=3600";

/** Build GooglePassData from a resolved token entry */
const buildPassData = async (
  entry: TokenEntry,
  token: string,
): Promise<GooglePassData> => {
  const { event, attendee } = entry;
  const domain = getAllowedDomain();
  const currencyCode = await getCurrencyCodeFromDb();
  const pricePaid = Number(await decrypt(attendee.price_paid));

  return {
    serialNumber: token,
    organizationName: domain,
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

/** Handle GET /gwallet/:token — redirect to Google Wallet save URL */
const handleGoogleWalletGet = async (
  _request: Request,
  tokens: string[],
): Promise<Response> => {
  // Only support single-token downloads
  const token = tokens[0];
  if (!token || tokens.length > 1) return notFoundResponse();

  const config = await getGoogleWalletConfig();
  if (!config) return notFoundResponse();

  const result = await lookupAttendees([token]);
  if (!result.ok) return result.response;

  const entries = await resolveEntries(result.attendees);
  const passData = await buildPassData(entries[0]!, token);
  const saveUrl = await buildGoogleWalletUrl(passData, config);

  return new Response(null, {
    status: 302,
    headers: {
      Location: saveUrl,
      "Cache-Control": CACHE_CONTROL,
    },
  });
};

/** Route Google Wallet pass requests */
export const routeGoogleWallet = createTokenRoute("gwallet", {
  GET: handleGoogleWalletGet,
});
