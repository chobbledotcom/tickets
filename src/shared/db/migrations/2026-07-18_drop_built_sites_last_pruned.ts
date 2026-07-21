import { columnDropMigration } from "./define.ts";

export default columnDropMigration(
  "2026-07-18_drop_built_sites_last_pruned",
  "built_sites",
  "Remove the unused built-site prune marker.",
);
