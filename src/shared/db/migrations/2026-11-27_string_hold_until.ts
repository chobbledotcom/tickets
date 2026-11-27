import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-11-27_string_hold_until",
  "Add hold_until to interned strings. A Square checkout holds the strings of its typed answers until its link can no longer take payment, and the prune keeps held strings. Every stored string starts with no hold.",
  { columns: { strings: ["hold_until"] } },
);
