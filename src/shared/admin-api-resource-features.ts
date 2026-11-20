/**
 * The admin feature that each API resource belongs to. While that feature is
 * off, the server refuses every route of the resource, and the docs leave the
 * resource out. A resource that is absent here belongs to no feature.
 */

import type { AdminApiResourceName } from "#shared/admin-api-resources.ts";
import type { AdminFeatureKey } from "#shared/admin-features.ts";

const RESOURCE_FEATURES: Partial<
  Record<AdminApiResourceName, AdminFeatureKey>
> = {
  attributes: "attributes",
  "external-sources": "externalSources",
  questions: "questions",
  "site-pages": "site",
};

/** The feature of the resource at one path. Undefined means the resource
 *  belongs to no feature, which is the documented case for most resources. */
export const resourceFeature = (path: string): AdminFeatureKey | undefined =>
  (RESOURCE_FEATURES as Partial<Record<string, AdminFeatureKey>>)[path];
