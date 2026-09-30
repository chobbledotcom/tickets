/**
 * Every admin area, and the routes it serves.
 *
 * This is the one place an admin route is declared. Its nav (`sections.ts`)
 * and its serving module (`area-loaders.ts`) are keyed by the same area names.
 * The declarations themselves live in the two alphabetical halves beside this
 * file; join a new area to the half its name sorts into.
 *
 * An area names the role that reaches it once. A route names a role only when
 * it differs from its area. `segments` lists a URL segment the area serves
 * without a page of its own, such as a POST-only endpoint.
 */

import { AREAS_A_L } from "#shared/admin-surface/areas-a-l.ts";
import { AREAS_M_Z } from "#shared/admin-surface/areas-m-z.ts";
import type { AdminAreasSpec } from "#shared/admin-surface/definitions.ts";

export const ADMIN_AREAS = {
  ...AREAS_A_L,
  ...AREAS_M_Z,
} as const satisfies AdminAreasSpec;
