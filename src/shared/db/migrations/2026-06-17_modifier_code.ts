import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-17_modifier_code",
  "Add an encrypted code column to modifiers for promo-code (trigger=code) modifiers; the public code box matches against code_index",
  {
    columns: { modifiers: ["code"] },
  },
);
