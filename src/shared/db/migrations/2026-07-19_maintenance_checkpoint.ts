import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-19_maintenance_checkpoint",
  "Remember where bounded maintenance scans should continue.",
  { columns: { maintenance_tasks: ["checkpoint"] } },
);
