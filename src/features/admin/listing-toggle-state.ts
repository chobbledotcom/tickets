/** The plain-words refusal when a listing already sits in the state a toggle
 *  wants. The page and the JSON API enforce the same rule through the shared
 *  {@link listingAlreadyInState} predicate. The page renders this copy, and
 *  the API answers with its own terse field-named message. */

import { t } from "#i18n";
import { listingAlreadyInState } from "#shared/listings-actions.ts";

/** The message when the listing's stored state already matches the wanted
 *  one, or null when the toggle can run. */
export const listingToggleStateError = (
  listingActive: boolean,
  wantedActive: boolean,
): string | null =>
  listingAlreadyInState(listingActive, wantedActive)
    ? t(
        wantedActive
          ? "error.listing_already_active"
          : "error.listing_already_deactivated",
      )
    : null;
