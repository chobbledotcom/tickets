/** Every machine the `/admin/schema` page maps. A new machine joins by
 * deriving one here — the page folds over this list and needs nothing else. */

import { paymentReviewAtlas } from "#shared/schema-atlas/payment-review.ts";
import { refundAuthorityAtlas } from "#shared/schema-atlas/refund-authority.ts";
import { rowLifecycleAtlas } from "#shared/schema-atlas/row-lifecycle.ts";
import { sumupRecoveryAtlas } from "#shared/schema-atlas/sumup-recovery.ts";
import type { AtlasMachine } from "#shared/schema-atlas/types.ts";

export const SCHEMA_ATLAS_MACHINES: readonly AtlasMachine[] = [
  refundAuthorityAtlas(),
  paymentReviewAtlas(),
  rowLifecycleAtlas(),
  sumupRecoveryAtlas(),
];
