// effects: pure
/** The review write rule, kept pure so both the form path and a direct test
 *  read the same decision without loading the database. */

import { errorResult, okResult, type Result } from "#shared/result.ts";
import { isIsoDate } from "#shared/validation/date-string.ts";
import { checkedName } from "#shared/validation/name.ts";

/** One review as a form and a write carry it. The URL index is computed by
 *  the table module. */
export type ReviewInput = {
  date: string;
  name: string;
  rating: number | null;
  text: string;
  url: string | null;
};

export type ReviewRuleError =
  | "dateInvalid"
  | "nameRequired"
  | "nameTooLong"
  | "ratingInvalid"
  | "textRequired"
  | "textTooLong"
  | "urlInvalid"
  | "urlTooLong";

export type ReviewRuleLimits = {
  name: number;
  text: number;
};

const urlError = (url: string, max: number): ReviewRuleError | null => {
  if (url.length > max) return "urlTooLong";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? null
      : "urlInvalid";
  } catch {
    return "urlInvalid";
  }
};

const validRating = (rating: number): boolean =>
  Number.isInteger(rating) && rating >= 1 && rating <= 5;

/** The one review rule. The form checks the same facts first. This keeps both
 *  admin doors and a later import to the same limits. */
export const reviewRule = (
  input: ReviewInput,
  limits: ReviewRuleLimits,
): Result<ReviewInput, ReviewRuleError> => {
  const name = checkedName<ReviewRuleError>(input.name, "nameRequired", {
    error: "nameTooLong",
    length: limits.name,
  });
  if (!name.ok) return errorResult(name.error);
  if (input.rating !== null && !validRating(input.rating)) {
    return errorResult("ratingInvalid");
  }
  if (!isIsoDate(input.date)) return errorResult("dateInvalid");
  const text = input.text.trim();
  if (text === "") return errorResult("textRequired");
  if (text.length > limits.text) return errorResult("textTooLong");
  const url = input.url === null ? "" : input.url.trim();
  const problem = url === "" ? null : urlError(url, limits.text);
  if (problem !== null) return errorResult(problem);
  return okResult({
    date: input.date,
    name: name.value,
    rating: input.rating,
    text,
    url: url === "" ? null : url,
  });
};
