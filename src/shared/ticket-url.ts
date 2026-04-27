/**
 * Build the combined ticket URL from attendee tokens
 */

import { map, pipe, unique } from "#fp";
import { getEffectiveDomain } from "#shared/config.ts";

type TokenEntry = { attendee: { ticket_token: string } };

export const buildTicketUrl = (entries: TokenEntry[]): string => {
  const tokens = pipe(
    map(({ attendee }: TokenEntry) => attendee.ticket_token),
    unique,
  )(entries);
  return `https://${getEffectiveDomain()}/t/${tokens.join("+")}`;
};

/** Build the check-in URL for a single ticket token */
export const buildCheckinUrl = (token: string): string =>
  `https://${getEffectiveDomain()}/checkin/${token}`;
