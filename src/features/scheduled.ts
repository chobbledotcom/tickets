/**
 * Maintenance-ping endpoint.
 *
 * Database pruning runs as interval-gated pending work on *every* request (see
 * `prepareRequestEnvironment`), so any traffic keeps a site pruned. This
 * endpoint exists so a cron can guarantee pruning still happens on a site with
 * no organic traffic: hitting `/scheduled` is just a cheap request that — like
 * any dynamic request — triggers this site's prune, then returns a tiny JSON
 * body. (Static asset routes short-circuit before pruning, so a cron must hit a
 * dynamic path like this one, not `/favicon.ico`.) GET is always a public ping.
 *
 * On a builder (`CAN_BUILD_SITES`), `POST /scheduled` additionally walks the
 * fleet: it pokes the least-recently-poked built site with a plain GET, which
 * triggers *that* site's own per-request prune, so one cron on the master keeps
 * every quiet client pruned. That walk advances a rotation and makes an
 * outbound request, so it is gated behind the master-only `SCHEDULED_TASKS_KEY`
 * (sent as a bearer token) — without a matching key the POST is rejected and no
 * walk happens. The poke sent to each client stays unauthenticated (any request
 * prunes them); the key only protects the master's trigger and is never shared
 * with the built sites, so there's no fleet-wide distribution or rotation.
 */

import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { getBearerToken } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { constantTimeEqual } from "#shared/crypto/utils.ts";
import {
  claimNextBuiltSiteForPrune,
  siteBaseUrl,
} from "#shared/db/built-sites.ts";
import { getEnv } from "#shared/env.ts";
import { fetchTextFollowingSafeRedirects } from "#shared/safe-fetch.ts";

const SCHEDULED_PATH = "/scheduled";

/** How long the master waits for a poked built site before giving up. The
 * client's rotation stamp is already bumped, so a timeout just means it gets
 * walked again next cycle rather than stalling the rotation. */
const POKE_TIMEOUT_MS = 30_000;

/** Outcome of poking a built site. Deliberately free of any client-identifying
 * detail (hostname, error text): a caller who can reach this endpoint must not
 * be able to enumerate which sites the builder operates. */
type PokeResult = { ok: boolean; status: number } | { failed: true };

/**
 * True when the request carries the master's `SCHEDULED_TASKS_KEY` as a bearer
 * token. The key is master-only — it gates the builder's fleet-walk trigger and
 * is never copied to built sites (they're poked unauthenticated) — so there's
 * no fleet-wide distribution or rotation to manage. Unset means the walk is
 * disabled and every POST is rejected.
 */
const scheduledKeyMatches = (request: Request): boolean => {
  const expected = getEnv("SCHEDULED_TASKS_KEY");
  if (!expected) return false;
  const provided = getBearerToken(request);
  return provided !== null && constantTimeEqual(provided, expected);
};

/**
 * Poke the least-recently-poked built site with a plain GET so its own
 * per-request pruning runs. The site's rotation stamp is bumped (inside
 * `claimNextBuiltSiteForPrune`) before the request goes out, so a slow or
 * failing site never stalls the round-robin. The poke goes through the
 * safe-redirect fetch, which validates the origin and every redirect hop
 * against the SSRF policy, so a built site whose stored URL redirects to an
 * internal address can't make the master follow it. Returns null when the
 * builder has no built sites yet.
 */
const pokeNextBuiltSite = async (): Promise<PokeResult | null> => {
  const next = await claimNextBuiltSiteForPrune();
  if (!next) return null;
  try {
    const url = `${siteBaseUrl(next.bunnyUrl)}${SCHEDULED_PATH}`;
    const result = await fetchTextFollowingSafeRedirects(url, {
      method: "GET",
      signal: AbortSignal.timeout(POKE_TIMEOUT_MS),
    });
    return { ok: result.ok, status: result.status };
  } catch {
    return { failed: true };
  }
};

/**
 * Handle a scheduled-tasks ping. This site's own prune is already scheduled as
 * pending work for the request, so the handler only needs to (optionally) step
 * the fleet. The fleet-walk is the one privileged action — it advances the
 * rotation and makes an outbound request — so on a builder it requires the
 * master's bearer key; everything else is a public no-op ping.
 */
const handleScheduled = async (request: Request): Promise<Response> => {
  if (request.method === "POST" && isBuilderEnabled()) {
    if (!scheduledKeyMatches(request)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    return jsonResponse({ ok: true, poked: await pokeNextBuiltSite() });
  }
  return jsonResponse({ ok: true, poked: null });
};

/** Scheduled-tasks routes — any hit self-prunes (via the request); an
 * authenticated POST on a builder also walks the built-site fleet. */
export const scheduledRoutes = defineRoutes({
  "GET /scheduled": handleScheduled,
  "POST /scheduled": handleScheduled,
});
