import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-10-01_square_link_ends",
  "Stage one sealed cancel handle per unpaid Square checkout, so the link expiry task can end it at the checkout window",
  {
    indexes: [],
    newTables: ["square_link_ends"],
  },
);
