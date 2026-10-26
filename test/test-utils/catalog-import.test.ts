import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { CatalogExportError } from "#routes/admin/catalog-transfer/export.ts";
import { errorResult, okResult } from "#shared/result.ts";
import {
  requireEntityImport,
  unwrapExport,
} from "#test-utils/catalog-import.ts";

test("unwrapExport returns the blob and refuses the error and null shapes", () => {
  expect(unwrapExport({ kind: "listing" })).toEqual({ kind: "listing" });
  expect(() => unwrapExport(new CatalogExportError("no"))).toThrow("no");
  expect(() => unwrapExport(null)).toThrow("export returned null");
});

test("requireEntityImport refuses a failed import and a bundle result", () => {
  expect(() => requireEntityImport(errorResult("nope"))).toThrow("nope");
  expect(() =>
    requireEntityImport(okResult({ groups: 1, kind: "bundle", listings: 2 })),
  ).toThrow("Expected one imported listing or group, got a bundle");
  expect(
    requireEntityImport(okResult({ id: 1, kind: "listing", name: "A" })),
  ).toEqual({ id: 1, kind: "listing", name: "A" });
});
