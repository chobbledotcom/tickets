/** Exact current debt. An entry says only that the gate must not grow. Move a
 *  field to a reviewed exemption or delete/connect it when its domain is read.
 *  The manifest names each owner path once, with the unread fields under it. */

import * as v from "valibot";
import {
  compareFindingIdentities,
  type FindingIdentity,
} from "#scripts/unread-fields/identity.ts";
import {
  manifestReader,
  ownerPathSchema,
} from "#scripts/unread-fields/manifest.ts";
import baselineJson from "./baseline.json" with { type: "json" };

/** The manifest entry of one owner. An unknown key is an error, so an entry
 *  holds nothing but its path and its fields. */
const debtSchema = v.strictObject({
  fields: v.pipe(
    v.array(v.string()),
    v.nonEmpty("A debt entry must name at least one field"),
  ),
  path: ownerPathSchema("debt entry"),
});

const readDebt = manifestReader(
  "baseline",
  "debt entry",
  debtSchema,
  (exportedFrom, { fields, path }): FindingIdentity[] =>
    fields.map((field) => ({ exportedFrom, field, path })),
);

/** Read one manifest into one exact identity for each field, in the stable
 *  order that the gate reports. */
export const parseBaseline = (manifest: unknown): FindingIdentity[] =>
  readDebt(manifest).toSorted(compareFindingIdentities);

export const UNREAD_FIELD_BASELINE: readonly FindingIdentity[] =
  parseBaseline(baselineJson);
