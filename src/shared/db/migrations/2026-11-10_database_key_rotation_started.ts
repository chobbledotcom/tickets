import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-11-10_database_key_rotation_started",
  "Record when each built site's latest database key rotation removed every old key. Only that rotation's timer link makes the new key.",
  {
    columns: { built_sites: ["database_key_rotation_started"] },
  },
);
