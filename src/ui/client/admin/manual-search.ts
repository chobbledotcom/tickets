/// <reference lib="dom" />
/** The manual check-in's search by name. The scanner page carries no list of
 * the door's people. A search asks the door's search route, or the saved
 * offline list when offline mode settles the door's check-ins. */

import * as v from "valibot";
import { SearchAnswerSchema } from "#shared/roster-option.ts";
import type { Wording } from "#shared/scanner-words.ts";
import { fetchOrNetworkError } from "#src/ui/client/dom.ts";
import type { Say } from "#src/ui/client/scanner-messages.ts";

/** One person a search found, from the door's search route or from the
 * saved list. `key` names the person's option on the page. `checkIn`
 * settles the pick, and answers whether the door is done with it. */
export type Person = {
  checkIn: (say: Say) => Promise<boolean>;
  details: string[];
  key: string;
  name: string;
  quantity: number;
};

/** The manual check-in's offline side. `active` says whether a pick settles
 * offline now. `search` answers the saved people whose name holds the text,
 * or null after the door hears why the list cannot answer. */
export type ManualOffline = {
  active: () => boolean;
  search: (text: string, say: Say) => Person[] | null;
};

/** What a search needs from the page. It names the door's search route, the
 * offline side, and how to report. `checkInById` checks in a person that
 * the search route found. */
export type SearchContext = {
  checkInById: (attendeeId: number) => Promise<boolean>;
  /** The offline side, or null when it did not start on this page. */
  offline: ManualOffline | null;
  say: Say;
  searchPath: string;
  wording: Wording;
};

/** The answers a retry cannot fix, so they read as a page fault: the
 * session expired, the role changed, or the door went away. Any other
 * failed answer is the server's own trouble, and the door can try again. */
const REFUSALS: ReadonlySet<number> = new Set([401, 403, 404]);

/** The people whose name holds the text: from the saved list while offline
 * mode settles the door, else from the door's search route. Null after the
 * door hears why there is no answer. A search answer of another shape
 * throws, so the door sees the search fail instead of a wrong list. */
export const findPeople = async (
  text: string,
  { checkInById, offline, say, searchPath, wording }: SearchContext,
): Promise<Person[] | null> => {
  if (offline?.active()) return offline.search(text, say);
  const res = await fetchOrNetworkError(
    `${searchPath}?q=${encodeURIComponent(text)}`,
  );
  if (!res.ok) {
    const refused = REFUSALS.has(res.status);
    say(wording.word(refused ? "pageError" : "searchFailed"), "error");
    return null;
  }
  const { options } = v.parse(SearchAnswerSchema, await res.json());
  return options.map(({ attendeeId, details, name, quantity }) => ({
    checkIn: () => checkInById(attendeeId),
    details,
    key: String(attendeeId),
    name,
    quantity,
  }));
};
