/**
 * Google Wallet pass route - /gwallet/:token
 * Generates a signed JWT and redirects to the Google Wallet save URL.
 */

import { settings } from "#db/settings.ts";
import { notFoundResponse } from "#routes/response.ts";
import {
  createTokenRoute,
  WALLET_CACHE_CONTROL,
} from "#routes/tickets/token-utils.ts";
import { buildGoogleWalletUrl } from "#shared/google-wallet.ts";
import { withPassData } from "./index.ts";

/** Handle GET /gwallet/:token — redirect to Google Wallet save URL */
const handleGoogleWalletGet = async (
  _request: Request,
  tokens: string[],
): Promise<Response> => {
  const config = settings.googleWallet.config;
  if (!config) return notFoundResponse();

  return withPassData(tokens, async (passData) => {
    const saveUrl = await buildGoogleWalletUrl(passData, config);

    return new Response(null, {
      headers: {
        "Cache-Control": WALLET_CACHE_CONTROL,
        Location: saveUrl,
      },
      status: 302,
    });
  });
};

/** Route Google Wallet pass requests */
export const routeGoogleWallet = createTokenRoute("gwallet", {
  GET: handleGoogleWalletGet,
});
