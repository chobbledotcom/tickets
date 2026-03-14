/**
 * Google Wallet pass route - /gwallet/:token
 * Generates a signed JWT and redirects to the Google Wallet save URL.
 */

import { getGoogleWalletConfig } from "#lib/db/settings.ts";
import { buildGoogleWalletUrl } from "#lib/google-wallet.ts";
import {
  createTokenRoute,
  lookupSingleTokenPassData,
  WALLET_CACHE_CONTROL,
} from "#routes/token-utils.ts";
import { notFoundResponse } from "#routes/utils.ts";

/** Handle GET /gwallet/:token — redirect to Google Wallet save URL */
const handleGoogleWalletGet = async (
  _request: Request,
  tokens: string[],
): Promise<Response> => {
  const config = await getGoogleWalletConfig();
  if (!config) return notFoundResponse();

  const result = await lookupSingleTokenPassData(tokens);
  if (!result.ok) return result.response;

  const saveUrl = await buildGoogleWalletUrl(result.passData, config);

  return new Response(null, {
    status: 302,
    headers: {
      Location: saveUrl,
      "Cache-Control": WALLET_CACHE_CONTROL,
    },
  });
};

/** Route Google Wallet pass requests */
export const routeGoogleWallet = createTokenRoute("gwallet", {
  GET: handleGoogleWalletGet,
});
