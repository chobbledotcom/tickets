/**
 * Apple Wallet web service endpoints for automatic pass updates.
 *
 * Implements the minimal subset of Apple's PassKit web service protocol:
 * - POST /v1/devices/:device/registrations/:passTypeId/:token → 201 (stub)
 * - DELETE /v1/devices/:device/registrations/:passTypeId/:token → 200 (stub)
 * - GET /v1/devices/:device/registrations/:passTypeId → always returns all tokens
 * - GET /v1/passes/:passTypeId/:token → serves fresh .pkpass
 * - POST /v1/log → 200 (stub)
 *
 * No device tracking or update timestamps — always says "everything is updated"
 * so devices re-download the pass on every manual refresh.
 */

import { getAppleWalletConfig } from "#lib/db/settings.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { buildPkpassForToken } from "#routes/wallet.ts";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** Stub: accept device registration */
const handleRegister = () => new Response(null, { status: 201 });

/** Stub: accept device unregistration */
const handleUnregister = () => new Response(null, { status: 200 });

/** Return all tokens for this pass type — always says "updated" */
const handleGetTokens = async (
  request: Request,
  params: { _device: string; passTypeId: string },
) => {
  const config = await getAppleWalletConfig();
  if (!config || params.passTypeId !== config.passTypeId) {
    return new Response(null, { status: 204 });
  }

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
};

/** Serve a fresh .pkpass for the given token */
const handleGetPass = async (
  _request: Request,
  params: { passTypeId: string; token: string },
) => {
  const config = await getAppleWalletConfig();
  if (!config || params.passTypeId !== config.passTypeId) {
    return new Response(null, { status: 404 });
  }

  return buildPkpassForToken(params.token, config);
};

/** Stub: accept log messages from devices */
const handleLog = () => new Response(null, { status: 200 });

export const routeWalletWebservice = createRouter(
  defineRoutes({
    "POST /v1/devices/:_device/registrations/:_passTypeId/:_token":
      handleRegister,
    "DELETE /v1/devices/:_device/registrations/:_passTypeId/:_token":
      handleUnregister,
    "GET /v1/devices/:_device/registrations/:passTypeId": handleGetTokens,
    "GET /v1/passes/:passTypeId/:token": handleGetPass,
    "POST /v1/log": handleLog,
  }),
);
