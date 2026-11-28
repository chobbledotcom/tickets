/** The reviews table: public customer reviews, sorted newest first.
 *
 *  The URL is unique through a blind index. The write computes the index from
 *  the URL, never accepts it from the caller, and refuses a URL another review
 *  already holds. The table's unique index is the final guard for two writes
 *  that arrive together.
 */

import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import { executeBatchWithResults, resultRows } from "#db/client.ts";
import { existenceProbe } from "#db/existence.ts";
import type { FillableRead } from "#db/fill-together.ts";
import { readRows } from "#db/read.ts";
import { records } from "#db/record-table.ts";
import { desc, valued } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import type { ReviewInput } from "#shared/reviews/rule.ts";
import type { Review } from "#shared/reviews/types.ts";

export type ReviewWriteError = "urlTaken";

const newestFirst = from(tables.reviews).orderBy((review) => [
  desc(review.date),
  desc(review.id),
]);

/** Every review, newest first. The public page and the admin list share it. */
export const getAllReviews = (): Promise<Review[]> =>
  readRows(newestFirst.everyColumn());

/** One review by id, or null when it is gone. */
export const getReviewById = (id: number) => records.reviews.find(id);

/** The existence probe the public nav and sitemap run without decrypting a
 *  row or reading the table. Cleared on every reviews write. */
const reviewExistence = existenceProbe(
  "reviews",
  sql`SELECT id FROM reviews LIMIT 1`,
);

/** The existence probe as a read the public nav can batch. */
export const reviewsExistenceRead: FillableRead = reviewExistence.read;

/** Does at least one review exist? Drives the public nav and sitemap link. */
export const hasReviews = reviewExistence.exists;

/** The URL index the unique constraint and this module both use. */
const urlIndexFor = (url: string | null): Promise<BlindIndex | null> =>
  url === null ? Promise.resolve(null) : hmacHash(url);

/** The table holds no review with this URL, except the row being updated. */
const urlIsFree = (urlIndex: string | null, excludeId?: number) =>
  valued<boolean>(
    urlIndex === null
      ? sql`1`
      : sql`NOT EXISTS (
      SELECT 1 FROM reviews AS existing
      WHERE existing.url_index = ${urlIndex}
      ${excludeId === undefined ? sql`` : sql`AND existing.id <> ${excludeId}`}
    )`,
  );

/** The one row a write returns, or null when its condition kept it out. */
const writtenRow = async (statement: SqlStatement): Promise<Review | null> => {
  const [result] = await executeBatchWithResults([statement]);
  return resultRows<Review>(result!)[0] ?? null;
};

const writeIndexed = async (
  url: string | null,
  write: (urlIndex: BlindIndex | null) => Promise<SqlStatement>,
): Promise<Result<Review, ReviewWriteError>> => {
  const urlIndex = await urlIndexFor(url);
  const row = await writtenRow(await write(urlIndex));
  return row === null ? errorResult("urlTaken") : okResult(row);
};

type ReviewWrite = (
  input: ReviewInput,
) => Promise<Result<Review, ReviewWriteError>>;

type ReviewUpdate = (
  id: number,
  input: ReviewInput,
) => Promise<Result<Review, ReviewWriteError>>;

/** Add one review. An existing URL answers `urlTaken`. */
export const createReview: ReviewWrite = (input) =>
  writeIndexed(input.url, (urlIndex) =>
    records.reviews.insertStatement(
      { ...input, urlIndex },
      { when: urlIsFree(urlIndex) },
    ),
  );

/** Change one review. A URL another review holds answers `urlTaken`. */
export const updateReview: ReviewUpdate = (id, input) =>
  writeIndexed(input.url, (urlIndex) =>
    records.reviews.updateStatement(id, { ...input, urlIndex }, () =>
      urlIsFree(urlIndex, id),
    ),
  );

/** Remove one review. */
export const deleteReview = (id: number): Promise<void> =>
  records.reviews.delete(id);
