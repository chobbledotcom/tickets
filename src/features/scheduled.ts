/**
 * Public scheduled-tasks endpoint.
 *
 * A single cron job POSTs here with the `SCHEDULED_TASKS_KEY` bearer token to
 * run this site's maintenance pruning (the work that used to happen
 * fire-and-forget on every request). When the env var is unset the endpoint is
 * disabled and 404s, so it is not discoverable on sites that don't use it.
 *
 * On a builder (CAN_BUILD_SITES), `?built=true` additionally forwards a prune to
 * the least-recently-pruned built site — the builder and its clients share the
 * key (copied via HOST_SECRETS), so the master authenticates to a client with
 * the same token. Each call steps one client, so one cron on the master walks
 * every client at the cron's pace while the master prunes itself each time.
 */

import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { getBearerToken } from "#routes/auth.ts";
import { jsonResponse, notFoundResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { constantTimeEqual } from "#shared/crypto/utils.ts";
import {
  claimNextBuiltSiteForPrune,
  siteBaseUrl,
} from "#shared/db/built-sites.ts";
import { maybeRunPrunes } from "#shared/db/prune.ts";
import { getEnv } from "#shared/env.ts";
import { fetchText } from "#shared/fetch.ts";

const SCHEDULED_PATH = "/scheduled";

/** How long the master waits for a forwarded prune before giving up. The
 * client's rotation stamp is already bumped, so a timeout just means it gets
 * walked again next cycle rather than stalling the rotation. */
const FORWARD_TIMEOUT_MS = 30_000;

/** Result of forwarding a prune to a built site. */
type ForwardResult =
  | { site: string; status: number; ok: boolean }
  | { site: string; error: string };

/**
 * Forward a prune to the least-recently-pruned built site. The site's rotation
 * stamp is bumped (inside claimNextBuiltSiteForPrune) before the request goes
 * out, so a slow or failing site never stalls the round-robin. Returns null
 * when the builder has no built sites yet.
 */
const forwardToBuiltSite = async (
  key: string,
): Promise<ForwardResult | null> => {
  const next = await claimNextBuiltSiteForPrune();
  if (!next) return null;
  const url = `${siteBaseUrl(next.bunnyUrl)}${SCHEDULED_PATH}`;
  try {
    const result = await fetchText(url, {
      headers: { authorization: `Bearer ${key}` },
      method: "POST",
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    return { ok: result.ok, site: next.bunnyUrl, status: result.status };
  } catch (e) {
    return { error: (e as Error).message, site: next.bunnyUrl };
  }
};

/** POST /scheduled — run this site's prune; on a builder, `?built=true` also
 * steps the built-site rotation. Bearer auth against SCHEDULED_TASKS_KEY. */
export const handleScheduledPost = async (
  request: Request,
): Promise<Response> => {
  const configured = getEnv("SCHEDULED_TASKS_KEY");
  // Unset → feature off. 404 (not 401) so the endpoint isn't discoverable.
  if (!configured) return notFoundResponse();

  const provided = getBearerToken(request);
  if (!provided || !constantTimeEqual(provided, configured)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  await maybeRunPrunes();

  const wantsBuilt = new URL(request.url).searchParams.get("built") === "true";
  const forwarded =
    wantsBuilt && isBuilderEnabled()
      ? await forwardToBuiltSite(configured)
      : null;

  return jsonResponse({ forwarded, ok: true, pruned: true });
};

/** Scheduled-tasks routes */
export const scheduledRoutes = defineRoutes({
  "POST /scheduled": handleScheduledPost,
});
