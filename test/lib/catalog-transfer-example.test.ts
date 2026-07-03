/**
 * Tests that the catalog-transfer examples in the documentation are valid
 * against the real transfer schema. The import/export JSON is one shared format,
 * so parsing each documented example with CatalogTransferSchema proves the guide
 * shows a shape the importer would actually accept. If the format changes, this
 * test fails and forces src/shared/catalog-transfer-example.ts (and the guide) to
 * be updated — a single source of truth, not a hand-maintained second copy.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { CatalogTransferSchema } from "#routes/admin/catalog-transfer/schema.ts";
import {
  CATALOG_GROUP_EXAMPLE,
  CATALOG_GROUP_EXAMPLE_JSON,
  CATALOG_LISTING_EXAMPLE,
  CATALOG_LISTING_EXAMPLE_JSON,
} from "#shared/catalog-transfer-example.ts";

describe("catalog transfer example", () => {
  test("the listing example parses as a valid catalog transfer blob", () => {
    const result = v.safeParse(CatalogTransferSchema, CATALOG_LISTING_EXAMPLE);
    expect(result.success).toBe(true);
  });

  test("the group example parses as a valid catalog transfer blob", () => {
    const result = v.safeParse(CatalogTransferSchema, CATALOG_GROUP_EXAMPLE);
    expect(result.success).toBe(true);
  });

  test("each example is canonical — parsing does not alter it", () => {
    // The rendered JSON is exactly the parsed (defaults-applied, transformed)
    // blob, so the guide never shows a shape that silently changes on import.
    expect(v.parse(CatalogTransferSchema, CATALOG_LISTING_EXAMPLE)).toEqual(
      CATALOG_LISTING_EXAMPLE,
    );
    expect(v.parse(CatalogTransferSchema, CATALOG_GROUP_EXAMPLE)).toEqual(
      CATALOG_GROUP_EXAMPLE,
    );
  });

  test("the rendered JSON is pretty-printed with two-space indenting", () => {
    expect(CATALOG_LISTING_EXAMPLE_JSON).toBe(
      JSON.stringify(CATALOG_LISTING_EXAMPLE, null, 2),
    );
    expect(CATALOG_GROUP_EXAMPLE_JSON).toBe(
      JSON.stringify(CATALOG_GROUP_EXAMPLE, null, 2),
    );
    expect(CATALOG_LISTING_EXAMPLE_JSON).toContain('\n  "kind": "listing"');
  });

  test("the group example demonstrates a package that hides its members", () => {
    // The guide's group example exists to show the package flags on; if either
    // flipped off it would document a plain group, not the package/privacy
    // feature it is meant to illustrate.
    expect(CATALOG_GROUP_EXAMPLE_JSON).toContain('"isPackage": true');
    expect(CATALOG_GROUP_EXAMPLE_JSON).toContain('"hidePackageListings": true');
  });
});
