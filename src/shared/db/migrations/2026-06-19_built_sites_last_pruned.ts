import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-19_built_sites_last_pruned",
  "Add a last_pruned column to built_sites so the scheduled-tasks endpoint can forward a prune to the least-recently-pruned built site and walk every site at a steady pace",
  {
    columns: { built_sites: ["last_pruned"] },
  },
);
