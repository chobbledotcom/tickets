import { schemaMigration } from "./define.ts";

/**
 * Add `bookable_alone` to listings so a child listing can keep its own
 * standalone booking page while it is also offered under one or more parents.
 * Default 0 ⇒ every existing child keeps today's behaviour (being a child
 * strips its standalone existence); the column rides the wide `SELECT listing.*`
 * caches and backup/restore automatically.
 */
export default schemaMigration(
  "2026-07-02_bookable_alone",
  "Add bookable_alone column to listings so a child can be sold on its own page while still offered under parents.",
  {
    columns: { listings: ["bookable_alone"] },
  },
);
