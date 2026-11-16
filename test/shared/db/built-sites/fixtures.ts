import { parseSiteDataBlob } from "#db/built-sites/blob.ts";
import type { BuiltSiteFormInput } from "#db/built-sites/types.ts";
import { createBuiltSite } from "#db/built-sites.ts";
import { records } from "#db/record-table.ts";

export const builtSiteFormInput = (
  overrides: Partial<BuiltSiteFormInput> = {},
): BuiltSiteFormInput => ({
  assignable: false,
  dbToken: "",
  dbUrl: "",
  hostingId: "",
  name: "Original",
  siteUrl: "original.bunny.run",
  ...overrides,
});

/** Store a new site from `input`, and give back the stored row with its blob
 *  opened. */
export const storedSiteRow = async (
  input: Parameters<typeof createBuiltSite>[0],
) => {
  const { id } = await createBuiltSite(input);
  const row = await records.built_sites.find(id);
  if (row === null) throw new Error(`Built site ${id} was not stored`);
  return { ...row, blob: parseSiteDataBlob(row.site_data) };
};
