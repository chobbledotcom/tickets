/**
 * Standardized response helpers for admin action outcomes.
 * Wraps redirect with a consistent API.
 */

import { redirect } from "#routes/response.ts";

/** Options for ok/fail response helpers */
export type ActionOutcomeOpts = {
  /** Form ID for flash message targeting */
  formId?: string;
  /** Additional cookie to set on the response */
  cookie?: string;
  /** Optional result payload stored in flash cookie */
  result?: string;
};

/** Create an action outcome redirector (success or error variant) */
const makeOutcome =
  (succeeded: boolean) =>
  (path: string, message: string, opts?: ActionOutcomeOpts): Response =>
    redirect(path, message, succeeded, {
      cookie: opts?.cookie,
      formId: opts?.formId,
      result: opts?.result,
    });

/** Redirect with a success message */
export const ok = makeOutcome(true);

/** Redirect with an error message */
export const fail = makeOutcome(false);
