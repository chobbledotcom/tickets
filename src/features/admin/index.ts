/**
 * Admin request routing.
 *
 * The area manifest owns lazy imports and message groups. This module folds it
 * into one router per URL segment, then handles authentication and request-only
 * footer state before dispatching the chosen area.
 */

import { once } from "#fp";
import { withMessageGroups } from "#i18n";
import { ADMIN_SHELL_MESSAGE_GROUPS } from "#locales/groups.ts";
import type { MessageGroup } from "#locales/manifest.ts";
import {
  ADMIN_AREA_LOADERS,
  type AdminAreaLoader,
} from "#routes/admin/area-loaders.ts";
import { isJsonApiPath } from "#routes/middleware.ts";
import { createRouter } from "#routes/router.ts";
import type { PathMethodRoute } from "#routes/types.ts";
import { adminPathSegment } from "#shared/admin-surface/definitions.ts";
import type { AdminAreaId } from "#shared/admin-surface/ids.ts";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";
import { enableFooterDebug } from "#shared/db/query-log.ts";
import { isStaffRole } from "#shared/types.ts";

type AdminSegment = {
  load: () => Promise<PathMethodRoute>;
  messageGroups: readonly MessageGroup[];
};

/** Build one lazy router per segment without importing any area handlers. */
const buildSegmentRouters = (): Record<string, AdminSegment> => {
  const areasBySegment: Record<string, AdminAreaLoader[]> = {};
  for (const [id, segments] of Object.entries(ADMIN_SURFACE.areas)) {
    const areaId = id as AdminAreaId;
    const loader = ADMIN_AREA_LOADERS[areaId];
    for (const segment of segments) {
      const areas = areasBySegment[segment] ?? [];
      areas.push(loader);
      areasBySegment[segment] = areas;
    }
  }

  const routers: Record<string, AdminSegment> = {};
  for (const [segment, areas] of Object.entries(areasBySegment)) {
    routers[segment] = {
      load: once(async () => {
        const maps = await Promise.all(areas.map((loader) => loader.load()));
        return createRouter(Object.assign({}, ...maps));
      }),
      messageGroups: [
        ...new Set([
          ...ADMIN_SHELL_MESSAGE_GROUPS,
          ...areas.flatMap((loader) => loader.messageGroupsFor(segment)),
        ]),
      ],
    };
  }
  return routers;
};

const segmentRouters = buildSegmentRouters();

/** Route admin requests after authenticating known protected segments. */
export const routeAdmin: PathMethodRoute = async (
  request,
  path,
  method,
  server,
) => {
  // Unknown segments 404 before session work, so probes stay cheap.
  const segment = adminPathSegment(path);
  const segmentRouter = Object.hasOwn(segmentRouters, segment)
    ? segmentRouters[segment]
    : undefined;
  if (!segmentRouter) return null;

  const { authFailure, getAuthenticatedSession } = await import(
    "#routes/auth.ts"
  );
  const session = await getAuthenticatedSession(request);
  if (
    !session &&
    !isJsonApiPath(path) &&
    segment !== "" &&
    segment !== "login"
  ) {
    return authFailure("html", "not-authenticated");
  }

  return await withMessageGroups(segmentRouter.messageGroups, async () => {
    // Query recording starts in prepareRequestEnvironment. Only staff can see
    // the footer that exposes it; delivery agents and editors cannot.
    if (method === "GET" && session && isStaffRole(session.adminLevel)) {
      enableFooterDebug();
    }

    // Some area modules translate form schemas while their module evaluates.
    const router = await segmentRouter.load();
    return router(request, path, method, server);
  });
};
