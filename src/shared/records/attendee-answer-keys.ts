/** The keys of an attendee answer that need a site feature. An answer leaves
 *  such a key out while its feature is off. */

import type { KeyAccess } from "#shared/rest/field-specs.ts";

export const ATTENDEE_FEATURE_KEYS = [
  { feature: "logistics", key: "split_logistics_agents" },
] as const satisfies readonly KeyAccess[];
