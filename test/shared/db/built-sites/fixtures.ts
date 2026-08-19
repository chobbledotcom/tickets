import type { builtSitesCrudTable } from "#db/built-sites.ts";

type BuiltSiteFormInput = Parameters<typeof builtSitesCrudTable.insert>[0];

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
