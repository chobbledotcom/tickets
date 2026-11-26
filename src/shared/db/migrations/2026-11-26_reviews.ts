/** The migration that adds the reviews table. */

import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-11-26_reviews",
  "Add customer reviews for the public reviews page. The reviewer name, review text, and URL are stored as env-key ciphertext. The URL also has an HMAC blind index with a unique constraint, so no two reviews can name the same review page.",
  {
    indexes: ["idx_reviews_url_index"],
    newTables: ["reviews"],
  },
);
