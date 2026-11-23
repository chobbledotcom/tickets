import { addFeatureTurnedOff, schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-11-03_external_sources",
  "Add the external sources directory, its links to records, and the feature that shows it",
  {
    indexes: [
      "idx_external_source_links_lookup",
      "idx_external_source_links_external",
      "idx_external_source_links_target",
    ],
    newTables: ["external_sources", "external_source_links"],
  },
  addFeatureTurnedOff("externalSources"),
);
