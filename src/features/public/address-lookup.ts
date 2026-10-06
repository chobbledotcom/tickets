/**
 * GET /address-lookup — the JSON endpoint behind the postcode search boxes on
 * the public booking form and the admin attendee forms.
 *
 * The provider API key never leaves the server: the browser calls this
 * same-origin route, which serves from the encrypted address_cache or proxies
 * to the configured provider. It 404s when no provider is configured (the
 * pages don't render a search box then either), and is throttled per IP
 * because each cache miss spends one of the operator's paid provider
 * requests. Authenticated staff are never throttled — the limiter guards
 * against anonymous abuse, not the operator's own attendee forms.
 */

import { makeIpRateLimiter } from "#db/login-attempts.ts";
import { t } from "#i18n";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { getAuthenticatedSession } from "#routes/auth.ts";
import { jsonResponse, notFoundResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { activeAddressLookupProvider } from "#shared/address-lookup/providers.ts";
import { lookupAddresses } from "#shared/address-lookup/service.ts";
import {
  ADDRESS_LOOKUP_LOCKOUT_MS,
  MAX_ADDRESS_LOOKUPS,
} from "#shared/limits.ts";
import { getRequestClientIp } from "#shared/request-context.ts";
import { isStaffRole } from "#types";

/** "address:" namespaces the counters away from login/booking limiters. */
const limiter = makeIpRateLimiter(
  "address:",
  MAX_ADDRESS_LOOKUPS,
  ADDRESS_LOOKUP_LOCKOUT_MS,
);

export const handleAddressLookupGet: TypedRouteHandler<
  "GET /address-lookup"
> = async (request) => {
  const provider = activeAddressLookupProvider();
  if (!provider) return notFoundResponse();

  const session = await getAuthenticatedSession(request);
  // Staff are never throttled — the limiter guards against anonymous abuse,
  // not the operator's own attendee forms. Any other signed-in role (agent,
  // editor, scanner) stays under the same per-IP limit as anonymous use.
  const staff = session !== null && isStaffRole(session.adminLevel);
  if (!staff) {
    const ip = getRequestClientIp();
    if (await limiter.isLimited(ip)) {
      return apiErrorResponse(t("address_lookup.rate_limited"), 429);
    }
    await limiter.record(ip);
  }

  const search = getSearchParam(request, "search");
  const outcome = await lookupAddresses(provider, search);
  if (!outcome.ok) return apiErrorResponse(outcome.error);
  // `addresses` is the lines-only list the public booking form reads.
  // `matches` adds each line's coordinates for the admin Logistics tab's map
  // pin — gated on the back-office staff roles that can open attendee pages,
  // so neither anonymous visitors nor restricted agent/editor sessions ever
  // receive geolocation data.
  return jsonResponse({
    addresses: outcome.value.map((match) => match.line),
    ...(staff ? { matches: outcome.value } : {}),
  });
};
