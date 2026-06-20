/**
 * Public maintenance-ping endpoint.
 *
 * Database pruning runs as interval-gated pending work on *every* request (see
 * `prepareRequestEnvironment`), so any traffic keeps a site pruned. This
 * endpoint exists so a cron can guarantee pruning still happens on a site with
 * no organic traffic: hitting `/scheduled` is just a cheap request that — like
 * any request — triggers this site's prune, then returns a tiny JSON body.
 *
 * On a builder (`CAN_BUILD_SITES`), `POST /scheduled` additionally pokes the
 * least-recently-poked built site with a plain GET, which triggers *that*
 * site's own per-request prune. So one cron on the master walks every client at
 * the cron's pace, and quiet client sites get pruned with no shared secret —
 * the poke is an ordinary unauthenticated request, and pruning only ever
 * deletes already-expired rows. Only POST walks, so a crawler's GET can't make
 * the master fan out.
 */

import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { jsonResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  claimNextBuiltSiteForPrune,
  siteBaseUrl,
} from "#shared/db/built-sites.ts";
import { fetchText } from "#shared/fetch.ts";

const SCHEDULED_PATH = "/scheduled";

/** How long the master waits for a poked built site before giving up. The
 * client's rotation stamp is already bumped, so a timeout just means it gets
 * walked again next cycle rather than stalling the rotation. */
const POKE_TIMEOUT_MS = 30_000;

/** Result of poking a built site to trigger its prune. */
type PokeResult =
  | { site: string; status: number; ok: boolean }
  | { site: string; error: string };

/**
 * Poke the least-recently-poked built site with a plain GET so its own
 * per-request pruning runs. The site's rotation stamp is bumped (inside
 * `claimNextBuiltSiteForPrune`) before the request goes out, so a slow or
 * failing site never stalls the round-robin. Returns null when the builder has
 * no built sites yet. Resolving the URL is inside the try so a malformed stored
 * hostname yields a structured error rather than a 500.
 */
const pokeNextBuiltSite = async (): Promise<PokeResult | null> => {
  const next = await claimNextBuiltSiteForPrune();
  if (!next) return null;
  try {
    const url = `${siteBaseUrl(next.bunnyUrl)}${SCHEDULED_PATH}`;
    const result = await fetchText(url, {
      method: "GET",
      signal: AbortSignal.timeout(POKE_TIMEOUT_MS),
    });
    return { ok: result.ok, site: next.bunnyUrl, status: result.status };
  } catch (e) {
    return { error: (e as Error).message, site: next.bunnyUrl };
  }
};

/**
 * Handle a scheduled-tasks ping. This site's own prune is already scheduled as
 * pending work for the request (`prepareRequestEnvironment`), so the handler
 * just steps the built-site rotation when a builder is POSTed to.
 */
const handleScheduled = async (request: Request): Promise<Response> => {
  const walk = request.method === "POST" && isBuilderEnabled();
  const poked = walk ? await pokeNextBuiltSite() : null;
  return jsonResponse({ ok: true, poked });
};

/** Scheduled-tasks routes — any hit self-prunes (via the request); POST on a
 * builder also pokes the next built site. */
export const scheduledRoutes = defineRoutes({
  "GET /scheduled": handleScheduled,
  "POST /scheduled": handleScheduled,
});
