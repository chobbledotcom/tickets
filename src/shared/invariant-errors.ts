/**
 * The few operator-facing errors that mean a promise OUR system makes was
 * broken — not a mistake the operator made. Most `error.*` messages are the
 * operator's to fix and stay out of error reporting; these are incidents.
 * Each exported reporter renders its flash message and also reports it
 * through the classified error fan-out (console, ntfy, activity log, Sentry),
 * so the person running the platform hears about it even if the operator who
 * saw the flash closes the page and moves on.
 *
 * Add a reporter here only when showing the message means data now needs a
 * manual repair — the exemplar is a provider refund that went through while
 * our own ledger write did not.
 */
import { t } from "#i18n";
import { ErrorCode, logError } from "#shared/logger.ts";

/** The catalog keys whose message means a system promise broke. */
type InvariantErrorKey = "error.refund_not_recorded";

/** Where the broken promise was observed, for the report's tags. */
type InvariantContext = {
  attendeeId?: number | undefined;
  listingId?: number | undefined;
};

/** Build the reporter for one broken promise: it renders the operator-facing
 * message AND reports it. Use a reporter instead of a bare `t(key)` wherever
 * a flash tells an operator to repair data by hand. */
const invariantReporter =
  (key: InvariantErrorKey) =>
  (context: InvariantContext = {}): string => {
    logError({ code: ErrorCode.INVARIANT_REPORTED, detail: key, ...context });
    return t(key);
  };

/** A provider refund went through but our ledger could not record it. */
export const reportRefundNotRecorded = invariantReporter(
  "error.refund_not_recorded",
);
