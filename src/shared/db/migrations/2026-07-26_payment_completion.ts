import { schemaMigration } from "./define.ts";

// The payment tables this once created are now made by
// 2026-07-26_payment_records. What is left is the mark on a built site saying
// which handing-over it is part of, which no other migration adds.
export default schemaMigration(
  "2026-07-26_payment_completion",
  "Remember which handing-over a built site is part of, so a retry resumes it.",
  {
    columns: { built_sites: ["assignment_effect"] },
    indexes: ["idx_built_sites_assignment_effect"],
  },
);
