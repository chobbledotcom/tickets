import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-10-19_site_page_hidden",
  "Add site_pages.hidden. The page editor's Hidden checkbox keeps a page off " +
    "the public menus and the sitemap; the page's direct link keeps serving " +
    "and answers with a noindex robots tag. The column defaults to 0, so " +
    "every stored page stays visible until an operator ticks the box.",
  {
    columns: { site_pages: ["hidden"] },
  },
);
