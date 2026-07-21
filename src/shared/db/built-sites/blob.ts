import * as v from "valibot";
import { isScheduledTaskKey } from "#shared/scheduled-keys.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";
import { builtSiteBlobColumns } from "./fields.ts";
import type {
  BuiltSiteBlobFields,
  BuiltSiteBlobInput,
  DbProvider,
  HostingProvider,
} from "./types.ts";

const SITE_DATA_BLOB_VERSION = 2;

export interface SiteDataBlob {
  d?: string;
  dp?: DbProvider;
  hp?: HostingProvider;
  n: string;
  rt?: string;
  s?: string;
  sk?: string;
  t?: string;
  u: string;
  v: 1 | typeof SITE_DATA_BLOB_VERSION;
}

const siteDataFields = {
  d: v.optional(v.string()),
  dp: v.optional(v.picklist(["bunny", "turso"])),
  hp: v.optional(v.picklist(["bunny", "deno"])),
  n: v.string(),
  rt: v.optional(v.string()),
  s: v.optional(v.string()),
  t: v.optional(v.string()),
  u: v.string(),
};

const SiteDataBlobSchema = v.union([
  v.strictObject({
    ...siteDataFields,
    v: v.optional(v.literal(1), 1),
  }),
  v.strictObject({
    ...siteDataFields,
    sk: v.optional(v.pipe(v.string(), v.check(isScheduledTaskKey))),
    v: v.literal(SITE_DATA_BLOB_VERSION),
  }),
]);
const siteDataJson = defineStoredJson(SiteDataBlobSchema);

export const buildSiteDataBlobFromInput = (
  input: Partial<BuiltSiteBlobInput>,
): string => {
  const blob = Object.fromEntries([
    ["v", SITE_DATA_BLOB_VERSION],
    ...builtSiteBlobColumns.flatMap((column) => {
      const key = column.siteKey as keyof BuiltSiteBlobInput;
      const value = (
        Object.hasOwn(input, key) ? input[key] : column.defaultValue
      ) as string | null;
      return column.required || value ? [[column.blobKey, value]] : [];
    }),
  ]);
  return siteDataJson.write(blob, "built_sites.site_data");
};

export const blobToSiteFields = (blob: SiteDataBlob): BuiltSiteBlobFields =>
  Object.fromEntries(
    builtSiteBlobColumns.map((column) => [
      column.siteKey,
      column.required
        ? blob[column.blobKey as keyof SiteDataBlob]
        : (blob[column.blobKey as keyof SiteDataBlob] ?? column.defaultValue),
    ]),
  ) as BuiltSiteBlobFields;

export const parseSiteDataBlob = (json: string): SiteDataBlob =>
  siteDataJson.read(json, "built_sites.site_data") as SiteDataBlob;
