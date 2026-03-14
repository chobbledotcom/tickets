/**
 * Apple Wallet pass download route - /wallet/:token
 * Generates and returns a .pkpass file for a single ticket token.
 * CDN-cacheable — passes are deterministic for a given token + settings.
 */

import { buildPkpass } from "#lib/apple-wallet.ts";
import { getAppleWalletConfig } from "#lib/db/settings.ts";
import {
  createTokenRoute,
  lookupSingleTokenPassData,
  WALLET_CACHE_CONTROL,
} from "#routes/token-utils.ts";
import { notFoundResponse } from "#routes/utils.ts";

/** MIME type for Apple Wallet passes */
const PKPASS_CONTENT_TYPE = "application/vnd.apple.pkpass";

/** .pkpass suffix required on all wallet URLs for iOS compatibility */
const PKPASS_EXT = ".pkpass";

/** Handle GET /wallet/:token.pkpass — generate and return .pkpass */
const handleWalletGet = async (
  _request: Request,
  tokens: string[],
): Promise<Response> => {
  const raw = tokens[0];
  if (!raw || tokens.length > 1) return notFoundResponse();

  // Require .pkpass extension
  if (!raw.endsWith(PKPASS_EXT)) return notFoundResponse();
  const token = raw.slice(0, -PKPASS_EXT.length);

  const config = await getAppleWalletConfig();
  if (!config) return notFoundResponse();

  // Apple needs the token without .pkpass extension for lookup
  const result = await lookupSingleTokenPassData([token]);
  if (!result.ok) return result.response;

  const passData = {
    ...result.passData,
    description: `Ticket for ${result.passData.eventName}`,
  };
  const pkpass = buildPkpass(passData, config);
  const body = pkpass as Uint8Array<ArrayBuffer>;

  return new Response(body, {
    headers: {
      "Content-Type": PKPASS_CONTENT_TYPE,
      "Content-Disposition": `inline; filename="ticket.pkpass"`,
      "Content-Length": String(body.byteLength),
      "Cache-Control": WALLET_CACHE_CONTROL,
    },
  });
};

/** Route wallet pass requests */
export const routeWallet = createTokenRoute("wallet", { GET: handleWalletGet });
