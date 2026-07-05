/**
 * GET /address-lookup — the JSON endpoint behind the postcode search boxes on
 * the public booking form and the admin attendee forms.
 *
 * The provider API key never leaves the server: the browser calls this
 * same-origin route, which serves from the encrypted address_cache or proxies
 * to the configured provider. It 404s when no provider is configured (the
 * pages don't render a search box then either), and is throttled per IP
 * because each cache miss spends one of the operator's paid provider
 * requests.
 */

import { lookupAddresses } from "#shared/address-lookup/service.ts";
import { activeAddressLookupProvider } from "#shared/address-lookup/providers.ts";
import { jsonResponse, notFoundResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getClientIp } from "#routes/url.ts";
import { makeIpRateLimiter } from "#shared/db/login-attempts.ts";
import { t } from "#i18n";
import {
  ADDRESS_LOOKUP_LOCKOUT_MS,
  MAX_ADDRESS_LOOKUPS,
} from "#shared/limits.ts";

/** "address:" namespaces the counters away from login/booking limiters. */
const limiter = makeIpRateLimiter(
  "address:",
  MAX_ADDRESS_LOOKUPS,
  ADDRESS_LOOKUP_LOCKOUT_MS,
);

export const handleAddressLookupGet: TypedRouteHandler<"GET /address-lookup"> =
  async (request, _params, server) => {
    const provider = activeAddressLookupProvider();
    if (!provider) return notFoundResponse();

    const ip = getClientIp(request, server);
    if (await limiter.isLimited(ip)) {
      return jsonResponse({ error: t("address_lookup.rate_limited") }, 429);
    }
    await limiter.record(ip);

    const search = new URL(request.url).searchParams.get("search") ?? "";
    const outcome = await lookupAddresses(provider, search);
    if (!outcome.ok) return jsonResponse({ error: outcome.error }, 400);
    return jsonResponse({ addresses: outcome.addresses });
  };
