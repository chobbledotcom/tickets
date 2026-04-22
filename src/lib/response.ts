/**
 * Standardized response helpers for admin action outcomes.
 * Wraps redirect/errorRedirect with a consistent API.
 */

import { errorRedirect, redirect } from "#routes/utils.ts";

/** Options for ok/fail response helpers */
export type ActionOutcomeOpts = {
  /** Form ID for flash message targeting */
  formId?: string;
  /** Additional cookie to set on the response */
  cookie?: string;
  /** Optional result payload stored in flash cookie */
  result?: string;
};

/**
 * Redirect with a success message.
 * Wraps `redirect` with a cleaner API.
 */
export const ok = (
  path: string,
  message: string,
  opts?: ActionOutcomeOpts,
): Response =>
  redirect(path, message, true, {
    cookie: opts?.cookie,
    formId: opts?.formId,
    result: opts?.result,
  });

/**
 * Redirect with an error message.
 * Wraps `errorRedirect` with a cleaner API.
 */
export const fail = (
  path: string,
  message: string,
  opts?: ActionOutcomeOpts,
): Response => errorRedirect(path, message, opts?.formId);
