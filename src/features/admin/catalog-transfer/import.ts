/* jscpd:ignore-start */
import * as v from "valibot";
import { requireValue } from "#shared/required-value.ts";
import { okResult, type Result } from "#shared/result.ts";
import type { AdminLevel } from "#types";
import { formatBundleFailures, importBundleItems } from "./bundle.ts";
import type { BundleFailure, ImportedBundle } from "./bundle-plan.ts";
import {
  fail,
  type ImportedEntity,
  importTransactionFailure,
} from "./import-listing.ts";
import {
  type CatalogBundle,
  CatalogTransferSchema,
  formatBundleIssues,
  formatTransferIssues,
} from "./schema.ts";

/* jscpd:ignore-end */

/** The entity kind a single-item import answers with, or undefined for a
 *  bundle document. */
const singleEntityKind = (
  output: v.InferOutput<typeof CatalogTransferSchema>,
): ImportedEntity["kind"] | undefined =>
  output.kind === "bundle" ? undefined : output.kind;

/** The one message a single-item import reports: the first failing guard for
 *  its item, exactly as the single-item write raised it. */
const firstSingleFailure = (failures: readonly BundleFailure[]): string =>
  requireValue(failures[0]?.reasons[0], "Import failure missing");

/**
 * Parses, validates, and applies one catalog transfer blob. A single listing
 * and a single group import as a bundle of one. They run the same validation
 * phases, the same write, and the same guards an array of listings runs.
 * Their result and failure messages keep the single-item shapes the routes
 * flash.
 */
export const importCatalog = async (
  blob: unknown,
  adminLevel?: AdminLevel,
): Promise<Result<ImportedEntity | ImportedBundle>> => {
  const parsed = v.safeParse(CatalogTransferSchema, blob);
  if (!parsed.success) {
    const isBundle =
      typeof blob === "object" &&
      blob !== null &&
      "kind" in blob &&
      blob.kind === "bundle";
    return fail(
      isBundle
        ? formatBundleIssues(parsed.issues, blob)
        : formatTransferIssues(parsed.issues),
    );
  }
  const output = parsed.output;
  const single = singleEntityKind(output);
  const bundle: CatalogBundle =
    output.kind === "bundle"
      ? output
      : output.kind === "listing"
        ? {
            groups: [],
            kind: "bundle",
            listings: [
              {
                groups: output.groups,
                listing: output.listing,
                parents: output.parents,
              },
            ],
            version: output.version,
          }
        : {
            groups: [{ group: output.group, members: output.members }],
            kind: "bundle",
            listings: [],
            version: output.version,
          };
  try {
    const outcome = await importBundleItems(bundle, adminLevel);
    if (!outcome.ok) {
      return fail(
        single === undefined
          ? formatBundleFailures(outcome.failures)
          : firstSingleFailure(outcome.failures),
      );
    }
    if (single === undefined) {
      return okResult({
        groups: outcome.created.filter((entity) => entity.kind === "group")
          .length,
        kind: "bundle",
        listings: outcome.created.filter((entity) => entity.kind === "listing")
          .length,
      });
    }
    return okResult(
      requireValue(
        outcome.created.find((entity) => entity.kind === single),
        `Imported ${single} missing`,
      ),
    );
  } catch (error) {
    return importTransactionFailure(error);
  }
};
