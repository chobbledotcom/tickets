import { FEATURE_BASELINE } from "#scripts/unread-fields/baseline/features.ts";
import { SHARED_A_PAYMENTS_BASELINE } from "#scripts/unread-fields/baseline/shared-a-payments.ts";
import { SHARED_DB_BASELINE } from "#scripts/unread-fields/baseline/shared-db.ts";
import { SHARED_PROVIDER_Z_BASELINE } from "#scripts/unread-fields/baseline/shared-provider-z.ts";
import { UI_BASELINE } from "#scripts/unread-fields/baseline/ui.ts";
import {
  compareFindingIdentities,
  type FindingIdentity,
} from "#scripts/unread-fields/identity.ts";

/** Exact current debt. An entry says only that the gate must not grow. Move a
 * field to a reviewed exemption or delete/connect it when its domain is read. */
export const UNREAD_FIELD_BASELINE: readonly FindingIdentity[] = [
  ...FEATURE_BASELINE,
  ...SHARED_DB_BASELINE,
  ...SHARED_A_PAYMENTS_BASELINE,
  ...SHARED_PROVIDER_Z_BASELINE,
  ...UI_BASELINE,
].toSorted(compareFindingIdentities);
