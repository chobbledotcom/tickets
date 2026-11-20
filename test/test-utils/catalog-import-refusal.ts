/**
 * One implementation for tests that pin the message a catalog import refuses
 * with. An import the test expected to be refused but that succeeded fails
 * the test here, so every call site keeps the refusal check.
 */

import { assert } from "@std/assert";
import type { ImportedBundle } from "#routes/admin/catalog-transfer/bundle-plan.ts";
import type { ImportedEntity } from "#routes/admin/catalog-transfer/import-listing.ts";
import type { Result } from "#shared/result.ts";

/** The refusal message of an import the catalog must reject. */
export const importRefusal = (
  result: Result<ImportedEntity | ImportedBundle>,
): string => {
  assert(!result.ok, "The catalog import was accepted.");
  return result.error;
};
