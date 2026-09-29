/**
 * How a refused or failed auth answers: the failure responses keyed by reason,
 * each with an html and a json variant.
 */

import { t } from "#i18n";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { htmlResponse, redirectResponse } from "#routes/response.ts";

/** The HTML 403 body: a role refusal says the account cannot open the page;
 *  an owner-only refusal says only the owner account can. The audience fact
 *  comes from the same route declaration that the guards admit by. */
const forbiddenBody = (detail?: ForbiddenDetail): string =>
  detail === "owner-only"
    ? t("auth.forbidden_owner_only")
    : t("auth.forbidden_role");

/** Shared auth failure response factories */
const htmlForbidden = () => htmlResponse(forbiddenBody(), 403);
const jsonForbidden = () => apiErrorResponse("Forbidden", 403);

/** Auth failure responses keyed by reason, with html and json variants side-by-side. */
const AUTH_FAILURES = {
  forbidden: {
    html: (detail?: ForbiddenDetail) =>
      htmlResponse(forbiddenBody(detail), 403),
    json: jsonForbidden,
  },
  "invalid-api-key": {
    html: htmlForbidden,
    json: () => apiErrorResponse("Invalid API key", 401),
  },
  "invalid-csrf": {
    html: () => htmlResponse("Invalid CSRF token", 403),
    json: jsonForbidden,
  },
  "not-authenticated": {
    html: () => redirectResponse("/admin"),
    json: () => apiErrorResponse("Not authenticated", 401),
  },
} satisfies Record<
  string,
  Record<"html" | "json", (...args: never[]) => Response>
>;

type AuthFailureReason = keyof typeof AUTH_FAILURES;

/** The channel a failure answers on: the html page or the json API. */
export type AuthChannel = keyof (typeof AUTH_FAILURES)[AuthFailureReason];

/** How a forbidden response narrows its who-can-open message: the route's
 *  declared audience knows whether the page is owner-only. */
export type ForbiddenDetail = "owner-only";

/** Construct a standardized auth failure response. */
export const authFailure = (
  channel: AuthChannel,
  reason: AuthFailureReason,
  forbiddenDetail?: ForbiddenDetail,
): Response => {
  const factory = AUTH_FAILURES[reason][channel] as (
    detail?: ForbiddenDetail,
  ) => Response;
  return factory(forbiddenDetail);
};
