import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-28_listing_use_defaults",
  "Add use_defaults column to listings so a listing can inherit the operator's listing defaults live instead of using its own stored values",
  {
    columns: { listings: ["use_defaults"] },
  },
);
