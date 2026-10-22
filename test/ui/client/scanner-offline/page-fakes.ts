/**
 * The door page's fakes the wiring suite drives: the elements the offline
 * mode resolves, the words the template carries, and the storage under its
 * localStorage. No happy-dom window and no built bundle — the module runs
 * straight from `#src`.
 */

import { mapStoreOver } from "#src/ui/client/scanner-door-store.ts";
import type { ScanAnswer } from "#src/ui/client/scanner-offline.ts";
import { DOOR_CACHE_KEY } from "#test/ui/client/scanner/fixture.ts";

export const SCAN_PATH = "/admin/groups/5/scan";
export const TOKENS_PATH = "/admin/groups/5/scan-tokens";

/** The page's words, as the template carries them onto the container. */
export const PAGE_WORDS: Record<string, string> = {
  messageAlreadyCheckedIn:
    "{name} already checked in for {listingName} ({tickets})",
  messageOfflineDuplicatesOne:
    "1 person was already checked in elsewhere: {names}.",
  messageOfflineDuplicatesOther:
    "{count} people were already checked in elsewhere: {names}.",
  messageOfflineQueueOne: "1 check-in waiting to send.",
  messageOfflineQueueOther: "{count} check-ins waiting to send.",
  messageOfflineScanNoList:
    "The saved ticket list is out of date or missing. Go online and reload the page to refresh it.",
  messageOfflineScanSaved:
    "Saved ticket. The check-in will send when the connection is back.",
  messageOfflineScanUnknown:
    "This ticket is not in the saved list. Go online to check it.",
  messageOfflineSendFailed:
    "Some check-ins did not send. They stay saved on this device.",
  messageOfflineSyncAlreadyCheckedIn:
    "{name} was already checked in elsewhere.",
  messageOfflineToggleOff: "Offline mode: off",
  messageOfflineToggleOn: "Offline mode: on",
};

/** One element the offline mode touches: the words it paints, the classes
 * it toggles, the attributes it sets, and the press it listens for. */
export const fakeElement = (id: string) => {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const listeners = new Map<string, () => void>();
  return {
    addEventListener: (kind: string, run: () => void): void =>
      void listeners.set(kind, run),
    classList: {
      contains: (name: string): boolean => classes.has(name),
      toggle: (name: string, force: boolean): void => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
    className: "",
    click: (): void => listeners.get("click")?.(),
    dataset: {} as Record<string, string>,
    getAttribute: (name: string): string | null => {
      const value = attributes.get(name);
      return value === undefined ? null : value;
    },
    id,
    setAttribute: (name: string, value: string): void =>
      void attributes.set(name, value),
    textContent: "",
  };
};

export type FakeElement = ReturnType<typeof fakeElement>;

/** One door page: the elements the offline mode resolves, the online event
 * it listens for, and the map-backed storage under its localStorage. */
export const fakePage = ({
  words = PAGE_WORDS,
  missing = [] as string[],
} = {}) => {
  const backing = new Map<string, string>();
  const container = fakeElement("scanner-container");
  // The page carries its door's cache key the way the template renders it:
  // base64url bytes the offline mode digests every scan under.
  container.dataset = { ...words, doorCacheKey: DOOR_CACHE_KEY };
  const banner = fakeElement("scanner-offline-banner");
  const queueLine = fakeElement("scanner-offline-queue");
  const toggle = fakeElement("scanner-offline-toggle");
  const byId = new Map<string, FakeElement>([
    ["scanner-offline-banner", banner],
    ["scanner-offline-queue", queueLine],
    ["scanner-offline-toggle", toggle],
  ]);
  for (const id of missing) byId.delete(`scanner-offline-${id}`);
  const onlineRuns: Array<() => void> = [];
  return {
    backing,
    banner,
    container,
    document: {
      getElementById: (id: string): FakeElement | null => byId.get(id) ?? null,
    },
    goOnline: (runs: Array<() => void>): void => {
      for (const run of runs) run();
    },
    onlineRuns,
    queueLine,
    status: fakeElement("scanner-status"),
    storage: mapStoreOver(backing),
    toggle,
    window: {
      addEventListener: (kind: string, run: () => void): void => {
        if (kind === "online") onlineRuns.push(run);
      },
    },
  };
};

export type Page = ReturnType<typeof fakePage>;

/** The page's own status writer, as scanner.js writes it. */
export const showStatus = (
  el: HTMLElement,
  text: string,
  kind: string,
): void => {
  el.textContent = text;
  el.className = `scanner-status-${kind}`;
};

/** A queued check-in's replay answer that checks the person in. */
export const checkedIn = (): ScanAnswer => ({
  listingName: "Doors",
  name: "Ada",
  quantity: 1,
  status: "checked_in",
  total: 1,
});

/** A queued check-in's replay answer that says another door already took
 * that person in. */
export const takenElsewhere = (name: string): ScanAnswer => ({
  listingName: "Doors",
  name,
  quantity: 1,
  status: "already_checked_in",
  total: 1,
});
