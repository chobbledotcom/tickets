import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-11-10_database_key_rotation_started",
  "Add the durable claim and millisecond start for each built site's database key rotation.",
  {
    columns: { built_sites: ["database_key_rotation_started"] },
  },
);
