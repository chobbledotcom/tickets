import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-09-15_group_scan_checks_in_all_listings",
  "Add groups.scan_checks_in_all_listings. A group's edit form offers a " +
    'checkbox, "Check in every listing in this group when scanning any". ' +
    "The column stores that preference: 0 keeps the default door rule (each " +
    "scan checks in one member listing at a time), 1 checks in every member " +
    "listing the ticket holds. The column defaults to 0, so every stored " +
    "group keeps the one-listing-at-a-time rule until an operator ticks the " +
    "box.",
  {
    columns: { groups: ["scan_checks_in_all_listings"] },
  },
);
