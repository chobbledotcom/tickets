/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** The manual check-in's search by name. The scanner page carries no list of
 * the door's people. A search asks the door's search route, or the saved
 * offline list when offline mode settles the door's check-ins. */

import type { RosterOption } from "#shared/roster-option.ts";

/** How the page reports one outcome to the door. */
export type Say = (text: string, type: "success" | "warning" | "error") => void;

/** One entry of the saved offline list, as the manual form reads it. The
 * offline side keeps the entry's digest, and the queue reads it there. */
export type SavedEntry = {
  details: string[];
  name: string;
  tickets: number;
};

/** The manual check-in's offline side. `active` says whether a pick settles
 * offline now. `search` answers the saved people whose name holds the text,
 * or null after the door hears why the list cannot answer. `pick` queues
 * one saved person's check-in. */
export type ManualOffline = {
  active: () => boolean;
  pick: (entry: SavedEntry, say: Say) => Promise<void>;
  search: (text: string, say: Say) => SavedEntry[] | null;
};

/** One person a search found: by attendee id from the door's search route,
 * or by ticket digest from the saved list. A saved person carries the call
 * that queues their check-in. */
export type Found =
  | (RosterOption & { kind: "online" })
  | {
      entry: SavedEntry;
      kind: "saved";
      queue: (say: Say) => Promise<void>;
    };

/** The fewest characters a search takes. The search route refuses fewer. */
export const SEARCH_MIN_LENGTH = 2;

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Whether a value is one person the search route answered. */
const isOnlineOption = (value: unknown): value is RosterOption => {
  // Object() turns a non-object into a wrapper that fails every field check.
  const option = Object(value) as Record<string, unknown>;
  return (
    Number.isSafeInteger(option.attendeeId) &&
    typeof option.name === "string" &&
    isStringList(option.details) &&
    Number.isSafeInteger(option.quantity)
  );
};

/** The people one search route answer names. Throws on a body of another
 * shape, so the door sees the search fail instead of a wrong list. */
const onlineFound = (body: unknown): Found[] => {
  const { options } = Object(body) as { options?: unknown };
  if (!Array.isArray(options) || !options.every(isOnlineOption)) {
    throw new Error("The search answered a body of another shape");
  }
  return options.map((option) => ({
    attendeeId: option.attendeeId,
    details: option.details,
    kind: "online",
    name: option.name,
    quantity: option.quantity,
  }));
};

/** The name, places and details one found person's option shows. */
export const foundFacts = (
  found: Found,
): { details: string[]; name: string; quantity: number } =>
  found.kind === "online"
    ? { details: found.details, name: found.name, quantity: found.quantity }
    : {
        details: found.entry.details,
        name: found.entry.name,
        quantity: found.entry.tickets,
      };

/** The search route beside one door's scan route, which ends in `/scan`. */
const searchPathOf = (scanPath: string): string => `${scanPath}-search`;

/** The people whose name holds the text: from the saved list while offline
 * mode settles the door, else from the door's search route. Null after the
 * door hears why there is no answer. */
export const findPeople = async (
  text: string,
  scanPath: string,
  offline: ManualOffline | null,
  say: Say,
  failedText: string,
): Promise<Found[] | null> => {
  if (offline?.active()) {
    const entries = offline.search(text, say);
    if (entries === null) return null;
    return entries.map((entry) => ({
      entry,
      kind: "saved",
      queue: (sayTo: Say) => offline.pick(entry, sayTo),
    }));
  }
  const res = await fetch(
    `${searchPathOf(scanPath)}?q=${encodeURIComponent(text)}`,
  );
  if (!res.ok) {
    say(failedText, "error");
    return null;
  }
  return onlineFound(await res.json());
};
