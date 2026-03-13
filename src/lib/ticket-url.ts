/**
 * Build the combined ticket URL from attendee tokens
 */

import { map } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";

type TokenEntry = { attendee: { ticket_token: string } };

export const buildTicketUrl = (entries: TokenEntry[]): string => {
  const tokens = map(({ attendee }: TokenEntry) => attendee.ticket_token)(
    entries,
  );
  return `https://${getAllowedDomain()}/t/${tokens.join("+")}`;
};
