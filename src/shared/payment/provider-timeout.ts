/** How long one provider HTTP call may wait before it gives up. A refund
 * send is armed before its POST, so a stuck call must become a timeout the
 * failure classifiers can read — never an open hang with no answer. */
export const PROVIDER_TIMEOUT_MS = 20_000;
