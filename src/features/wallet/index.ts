/**
 * Apple Wallet pass download route - /wallet/:token
 * Generates and returns a .pkpass file for a single ticket token.
 * CDN-cacheable — passes are deterministic for a given token + settings.
 */

import { notFoundResponse } from "#routes/response.ts";
import {
  createTokenRoute,
  lookupSingleTokenPassData,
  WALLET_CACHE_CONTROL,
} from "#routes/tickets/token-utils.ts";
import { buildPkpass, type SigningCredentials } from "#shared/apple-wallet.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";

/** MIME type for Apple Wallet passes */
const PKPASS_CONTENT_TYPE = "application/vnd.apple.pkpass";

/** .pkpass suffix required on all wallet URLs for iOS compatibility */
const PKPASS_EXT = ".pkpass";

/** Handle GET /wallet/:token.pkpass — generate and return .pkpass */
const handleWalletGet: ResponseHandler<
  [_request: Request, tokens: string[]]
> = (_request, tokens) => {
  const raw = tokens[0];
  if (!raw || tokens.length > 1) return notFoundResponse();

  // Require .pkpass extension
  if (!raw.endsWith(PKPASS_EXT)) return notFoundResponse();
  const token = raw.slice(0, -PKPASS_EXT.length);

  if (!settings.appleWallet.config) return notFoundResponse();

  return buildPkpassForToken(token, settings.appleWallet.config);
};

/** The pass data a single verified ticket token resolves to. */
type SingleTokenPassData = Extract<
  Awaited<ReturnType<typeof lookupSingleTokenPassData>>,
  { ok: true }
>["passData"];

/**
 * Look up the single token's pass data and hand it to the builder, or return
 * the not-found/error response when the token doesn't resolve. Shared by the
 * Apple and Google wallet routes, which build different passes from the same
 * lookup.
 */
export const withPassData = async (
  tokens: string[],
  build: ResponseHandler<[passData: SingleTokenPassData]>,
): Promise<Response> => {
  const result = await lookupSingleTokenPassData(tokens);
  return result.ok ? build(result.passData) : result.response;
};

/**
 * Build and return a .pkpass Response for a token.
 * Shared by the download route and the web service "get latest pass" endpoint.
 */
export const buildPkpassForToken = (
  token: string,
  config: SigningCredentials,
): Promise<Response> =>
  withPassData([token], (passData) => {
    const domain = getEffectiveDomain();
    const fullPassData = {
      ...passData,
      description: `Ticket for ${passData.listingName}`,
      webServiceURL: `https://${domain}`,
    };
    const pkpass = buildPkpass(fullPassData, config);
    const body = pkpass as Uint8Array<ArrayBuffer>;

    return new Response(body, {
      headers: {
        "Cache-Control": WALLET_CACHE_CONTROL,
        "Content-Disposition": `inline; filename="ticket.pkpass"`,
        "Content-Length": String(body.byteLength),
        "Content-Type": PKPASS_CONTENT_TYPE,
      },
    });
  });

/** Route wallet pass requests */
export const routeWallet = createTokenRoute("wallet", { GET: handleWalletGet });
