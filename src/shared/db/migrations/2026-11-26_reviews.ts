/** The migration that adds the reviews table and its one sample review. */

import { encrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { sql } from "#db/sql.ts";
import { schemaMigration } from "./define.ts";

const SAMPLE_URL = "https://example.com/reviews/sample";

export default schemaMigration(
  "2026-11-26_reviews",
  "Add customer reviews for the public reviews page. The reviewer name, review text, and URL are stored as env-key ciphertext. The URL also has an HMAC blind index with a unique constraint, so no two reviews can name the same review page. One sample review shows the page before the owner imports real reviews.",
  {
    indexes: ["idx_reviews_url_index"],
    newTables: ["reviews"],
  },
  async ({ getDb }) => {
    await getDb().execute(
      sql`INSERT INTO reviews (name, rating, date, text, url, url_index)
          VALUES (
            ${await encrypt("Sample customer")},
            5,
            ${"2026-11-24"},
            ${await encrypt("This is a sample review. Your imported Google reviews will appear here, in this layout.")},
            ${await encrypt(SAMPLE_URL)},
            ${await hmacHash(SAMPLE_URL)}
          )`,
    );
  },
);
