/**
 * The feature gate of one admin API resource. A resource that belongs to a
 * feature answers the same refusal on every route while that feature is off.
 */

import { mapValues } from "@std/collections";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { apiErrorResponse } from "#routes/api/cors.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { resourceFeature } from "#shared/admin-api-resource-features.ts";
import type { AdminApiResource } from "#shared/admin-api-resources.ts";
import {
  ADMIN_FEATURES_BY_KEY,
  type AdminFeatureKey,
} from "#shared/admin-features.ts";

/** The name of one feature as a sentence holds it. */
const featureName = (key: AdminFeatureKey): string =>
  t(ADMIN_FEATURES_BY_KEY[key].labelKey).toLowerCase();

/** The routes of one resource, each one refused while the feature of the
 *  resource is off. A resource of no feature keeps its routes as they are. */
export const gatedByFeature = (
  entry: AdminApiResource,
  routes: Record<string, RouteHandlerFn>,
): Record<string, RouteHandlerFn> => {
  const feature = resourceFeature(entry.path);
  if (feature === undefined) return routes;
  return mapValues(
    routes,
    (handler): RouteHandlerFn =>
      (request, params) =>
        settings.features[feature]
          ? handler(request, params)
          : apiErrorResponse(
              t("features.api_disabled", { feature: featureName(feature) }),
              403,
            ),
  );
};
