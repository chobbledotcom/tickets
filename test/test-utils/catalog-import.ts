/**
 * Test helpers for catalog import results. `importCatalog` answers either one
 * created entity or a bundle's created counts; most tests import one entity,
 * so they narrow with {@link requireEntityImport} instead of asserting the
 * union's shape by hand.
 */

import { loadCatalogNameIndex } from "#db/name-registry.ts";
import type { ImportedBundle } from "#routes/admin/catalog-transfer/bundle-plan.ts";
import { CatalogExportError } from "#routes/admin/catalog-transfer/export.ts";
import type { ImportedEntity } from "#routes/admin/catalog-transfer/import-listing.ts";
import { type Result, requireSuccess } from "#shared/result.ts";

/** Unwrap a successful export, failing if it returned null or an
 * (unexpected-in-these-tests) {@link CatalogExportError}. */
export const unwrapExport = <T>(blob: T | CatalogExportError | null): T => {
  if (blob instanceof CatalogExportError) throw new Error(blob.message);
  if (blob === null) throw new Error("export returned null");
  return blob;
};

/** Unwrap a successful import of ONE listing or group. A bundle import —
 * which reports counts instead of one entity — fails the test. */
export const requireEntityImport = (
  result: Result<ImportedEntity | ImportedBundle>,
): ImportedEntity => {
  const imported = requireSuccess(result);
  if (imported.kind === "bundle") {
    throw new Error("Expected one imported listing or group, got a bundle");
  }
  return imported;
};

/** Unwrap a successful BUNDLE import. A one-entity import fails the test. */
export const requireBundleImport = (
  result: Result<ImportedEntity | ImportedBundle>,
): ImportedBundle => {
  const imported = requireSuccess(result);
  if (imported.kind !== "bundle") {
    throw new Error("Expected a bundle import with created counts");
  }
  return imported;
};

/** The id of the one stored listing the name index resolves. */
export const storedListingIdOf = async (name: string): Promise<number> => {
  const { listing } = await loadCatalogNameIndex();
  const match = listing.get(name.trim().toLowerCase())?.[0];
  if (match === undefined) throw new Error(`no listing named ${name}`);
  return match;
};

/** The id of the one stored group the name index resolves. */
export const storedGroupIdOf = async (name: string): Promise<number> => {
  const { group } = await loadCatalogNameIndex();
  const match = group.get(name.trim().toLowerCase())?.[0];
  if (match === undefined) throw new Error(`no group named ${name}`);
  return match;
};
