import { schemaMigration } from "./define.ts";

/**
 * News posts shown on the public /news page and syndicated over RSS. All free
 * text (slug, name, meta_title, meta_description, snippet, content) is stored
 * encrypted; `created` stays plaintext — like listings.created — so the
 * newest-first ordering and the RSS pubDate never need a scan-and-decrypt.
 * `slug_index` is the plaintext HMAC blind index of the `/news/:slug`
 * permalink. Images attach through the existing first-class `image_uses`
 * table with item_type 'news'.
 */
export default schemaMigration(
  "2026-07-06_news_posts",
  "Add the news_posts table backing the public news system.",
  {
    indexes: ["idx_news_posts_created", "idx_news_posts_slug_index"],
    newTables: ["news_posts"],
  },
);
