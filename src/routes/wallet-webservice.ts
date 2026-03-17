/**
 * Apple Wallet web service endpoints for automatic pass updates.
 *
 * Implements the minimal subset of Apple's PassKit web service protocol:
 * - POST /v1/devices/:device/registrations/:passType/:token → 201 (stub)
 * - DELETE /v1/devices/:device/registrations/:passType/:token → 200 (stub)
 * - GET /v1/devices/:device/registrations/:passType → always returns all tokens
 * - GET /v1/passes/:passType/:token → serves fresh .pkpass
 * - POST /v1/log → 200 (stub)
 *
 * No device tracking or update timestamps — always says "everything is updated"
 * so devices re-download the pass on every manual refresh.
 */

import type { SigningCredentials } from "#lib/apple-wallet.ts";
import { getAppleWalletConfig } from "#lib/db/settings.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { buildPkpassForToken } from "#routes/wallet.ts";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** Verify passType matches config, then run handler. Returns failure status on mismatch. */
const withVerifiedPass =
  (failStatus: number) =>
  (handler: (config: SigningCredentials) => Response | Promise<Response>) =>
  async (passType: string): Promise<Response> => {
    const config = await getAppleWalletConfig();
    return config && passType === config.passTypeId
      ? handler(config)
      : new Response(null, { status: failStatus });
  };

/** Stub: accept device registration */
const handleRegister = () => new Response(null, { status: 201 });

/** Stub: accept device unregistration */
const handleUnregister = () => new Response(null, { status: 200 });

/** Return all tokens for this pass type — always says "updated" */
const handleGetTokens = (
  request: Request,
  params: { _device: string; passType: string },
) =>
  withVerifiedPass(204)((_config) => {
    const authHeader = request.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^ApplePass\s+/i, "");
    if (!token) return new Response(null, { status: 401 });

    // Ignore passesUpdatedSince — always return the token as updated
    return new Response(
      JSON.stringify({
        serialNumbers: [token],
        lastUpdated: String(Date.now()),
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  })(params.passType);

/** Serve a fresh .pkpass for the given token */
const handleGetPass = (
  _request: Request,
  params: { passType: string; token: string },
) =>
  withVerifiedPass(404)((config) => buildPkpassForToken(params.token, config))(
    params.passType,
  );

/** Stub: accept log messages from devices */
const handleLog = () => new Response(null, { status: 200 });

export const routeWalletWebservice = createRouter(
  defineRoutes({
    "POST /v1/devices/:_device/registrations/:_passType/:_token":
      handleRegister,
    "DELETE /v1/devices/:_device/registrations/:_passType/:_token":
      handleUnregister,
    "GET /v1/devices/:_device/registrations/:passType": handleGetTokens,
    "GET /v1/passes/:passType/:token": handleGetPass,
    "POST /v1/log": handleLog,
  }),
);
