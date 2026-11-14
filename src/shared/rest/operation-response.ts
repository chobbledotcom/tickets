/** Resolve one write result through its success or failure response path. */

import { notFoundResponse } from "#routes/response.ts";

/** The failure shapes a write command answers: a refusal with its message, or
 * a row that is not there. */
type OperationFailure =
  | { error: string; ok: false }
  | { error?: never; notFound: true; ok: false };

export const operationResponse = async <Success extends { ok: true }, Output>(
  result: Success | OperationFailure,
  onSuccess: (result: Success) => Output | Promise<Output>,
  renderError: (error: string) => Response | Promise<Response>,
): Promise<Output | Response> =>
  result.ok
    ? onSuccess(result)
    : "notFound" in result
      ? notFoundResponse()
      : renderError(result.error);
