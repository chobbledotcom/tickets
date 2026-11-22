import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-11-21_checkout_bundles",
  "Keep the whole order of a card checkout in a sealed row, so the provider's metadata only holds the key",
  {
    indexes: [],
    newTables: ["checkout_bundles"],
  },
);
