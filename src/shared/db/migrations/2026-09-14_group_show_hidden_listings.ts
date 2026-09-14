import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-09-14_group_show_hidden_listings",
  "Add groups.show_hidden_listings. A regular group's public booking page " +
    "offers the member listings it marks Hidden only while its own flag says " +
    "so. The column defaults to 1, so every stored group keeps offering its " +
    "hidden members until an operator unticks the group's box. Package groups " +
    "ignore the flag: a bundle is one product built from every member.",
  {
    columns: { groups: ["show_hidden_listings"] },
  },
);
