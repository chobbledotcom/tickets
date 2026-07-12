/** Pure SQL projections shared by listing record loaders. */

import {
  accountBalanceSubquery,
  creditsLessWriteoffDebits,
} from "#shared/accounting/projection-sql.ts";
import { imageFilenameSubqueries } from "#shared/db/images.ts";

const listingIncomeProjection = (idExpression: string): string =>
  `${creditsLessWriteoffDebits("revenue", idExpression)} AS income`;

const listingCostProjection = (idExpression: string): string =>
  `-${accountBalanceSubquery("cost", idExpression)} AS cost`;

const listingMoneyProjections = (idExpression: string): string =>
  [
    listingIncomeProjection(idExpression),
    listingCostProjection(idExpression),
  ].join(", ");

const listingDayPriceProjection = (idExpression: string): string =>
  `COALESCE((SELECT json_group_object(listingPrice.price_id, listingPrice.unit_price)
      FROM listing_prices AS listingPrice
      WHERE listingPrice.listing_id = ${idExpression}
        AND listingPrice.price_type = 'day_count'), '{}') AS day_prices`;

const listingImageProjections = (idExpression: string): string =>
  imageFilenameSubqueries("listing", idExpression);

/** A complete stored listing row plus its ledger, day-price, and image values. */
export const listingProjectionSql = (alias: string): string => {
  const idExpression = `${alias}.id`;
  return `${alias}.*,
       ${listingMoneyProjections(idExpression)},
       ${listingDayPriceProjection(idExpression)},
       ${listingImageProjections(idExpression)}`;
};

/** Base SELECT for listing records with the trigger-maintained booking count. */
export const LISTING_COUNT_SELECT = `SELECT ${listingProjectionSql("listing")},
       listing.booked_quantity AS attendee_count
     FROM listings AS listing`;
