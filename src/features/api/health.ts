/**
 * Health check route.
 *
 * Returns a plain "Up :)" liveness reply by default. A request carrying the
 * matching `X-Debug-Key` header (when `DEBUG_KEY` is configured) instead gets a
 * small JSON diagnostics payload — the running build's commit and timestamp —
 * which is handy for operators (and lets a backup/ops tool read which commit a
 * site is on) without exposing anything private.
 */

import { encodeBody } from "#routes/response.ts";
import { BUILD_COMMIT, BUILD_TIMESTAMP } from "#shared/build-info.ts";
import { getDebugKey } from "#shared/config.ts";
import { constantTimeEqual } from "#shared/crypto/utils.ts";
import { nowIso } from "#shared/now.ts";

/** Header carrying the diagnostic key. */
const DEBUG_KEY_HEADER = "x-debug-key";

/** Default liveness body — no information beyond "the script is running". */
const UP_RESPONSE = encodeBody("Up :)");

/**
 * True when the request presents the configured DEBUG_KEY (constant-time
 * compare). Always false when DEBUG_KEY is unset, so verbose health stays off
 * unless an operator opts in.
 */
const isDebugAuthorized = (request: Request): boolean => {
  const key = getDebugKey();
  const provided = request.headers.get(DEBUG_KEY_HEADER);
  return key !== "" && provided !== null && constantTimeEqual(provided, key);
};

/**
 * Handle health check request — plain liveness by default, JSON build
 * diagnostics when the request is authorized with the debug key.
 */
export const handleHealthCheck = (request: Request): Response => {
  if (!isDebugAuthorized(request)) {
    return new Response(UP_RESPONSE, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const body = JSON.stringify({
    buildTimestamp: BUILD_TIMESTAMP,
    commit: BUILD_COMMIT,
    serverTime: nowIso(),
  });
  return new Response(encodeBody(body), {
    headers: { "content-type": "application/json" },
  });
};
