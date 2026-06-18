import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-18_modifier_min_visits",
  "Add a min_visits column to modifiers so automatic returning-customer discounts can be gated on a buyer's visit count",
  {
    columns: { modifiers: ["min_visits"] },
  },
);
