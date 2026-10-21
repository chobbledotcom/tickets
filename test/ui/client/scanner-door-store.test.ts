/** The scanner door's offline store: the saved digest list, the queue, and
 * the switch. Pure store rules over a plain object. The page wiring around
 * them lands with the scanner's offline mode. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type DoorScope,
  dropQueuedCheckIn,
  type KeyValueStore,
  offlineModeOn,
  queueCheckIn,
  queuedCheckIns,
  savedHashList,
  saveHashList,
  scopeFromTokensPath,
  setOfflineMode,
} from "#src/ui/client/scanner-door-store.ts";

const LISTING = { id: 7, kind: "listing" } as const;

/** Twelve hours, the longest a saved list may answer scans. */
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

/** A plain-object store, so each test reads the door's slots back exactly
 * as they were written. Two views over one record are two page visits over
 * the same storage. */
const storeOver = (data: Record<string, string> = {}): KeyValueStore => ({
  getItem: (key) => data[key] ?? null,
  key: (index) => Object.keys(data)[index] ?? null,
  get length() {
    return Object.keys(data).length;
  },
  removeItem: (key) => delete data[key],
  setItem: (key, value) => {
    data[key] = value;
  },
});

/** The stored values the tests read raw, key and all. */
const storedRaw = (store: KeyValueStore, key: string): string | null =>
  store.getItem(key);

/** The digests in queue order, for tests that name tickets, not ids. */
const queuedHashes = (store: KeyValueStore, scope: DoorScope): string[] =>
  queuedCheckIns(store, scope).map((checkIn) => checkIn.tokenHash);

describe("the scanner door's offline store", () => {
  test("reads the door scope out of the token path", () => {
    expect(scopeFromTokensPath("/admin/listing/7/scan-tokens")).toEqual({
      id: 7,
      kind: "listing",
    });
    expect(scopeFromTokensPath("/admin/groups/12/scan-tokens")).toEqual({
      id: 12,
      kind: "group",
    });
    expect(() => scopeFromTokensPath("/admin/listing/7/scanner")).toThrow();
  });

  test("saves the digest list once, sorted and unique, with its moment", () => {
    const store = storeOver();
    saveHashList(store, LISTING, ["bb", "aa", "bb"], 1_000);
    const saved = savedHashList(store, LISTING, 2_000);
    expect([...saved!]).toEqual(["aa", "bb"]);
    expect(JSON.parse(storedRaw(store, "scanner:hashes:listing-7")!)).toEqual({
      hashes: ["aa", "bb"],
      savedAt: 1_000,
    });
  });

  test("a scan checks its digest against the saved list", () => {
    const store = storeOver();
    saveHashList(store, LISTING, ["aa", "bb"], 1_000);
    const saved = savedHashList(store, LISTING, 1_000)!;
    expect(saved.has("aa")).toBe(true);
    expect(saved.has("cc")).toBe(false);
  });

  test("answers the saved list while it is inside its twelve hours", () => {
    const store = storeOver();
    saveHashList(store, LISTING, ["aa"], 1_000);
    expect(savedHashList(store, LISTING, 1_000 + TWELVE_HOURS_MS)).toEqual(
      new Set(["aa"]),
    );
  });

  test("an expired list answers nothing and deletes itself", () => {
    const store = storeOver();
    saveHashList(store, LISTING, ["aa"], 1_000);
    expect(
      savedHashList(store, LISTING, 1_000 + TWELVE_HOURS_MS + 1),
    ).toBeNull();
    expect(storedRaw(store, "scanner:hashes:listing-7")).toBeNull();
  });

  test("a saved slot with no saved moment counts as no list and goes away", () => {
    const store = storeOver({
      "scanner:hashes:listing-7": '{"hashes":["aa"]}',
    });
    expect(savedHashList(store, LISTING, 1_000)).toBeNull();
    expect(storedRaw(store, "scanner:hashes:listing-7")).toBeNull();
  });

  test("a saved list keeps its string entries and drops the rest", () => {
    const store = storeOver({
      "scanner:hashes:listing-7": '{"hashes":["aa",42],"savedAt":1000}',
    });
    expect(savedHashList(store, LISTING, 1_000)).toEqual(new Set(["aa"]));
  });

  test("junk in the saved slot counts as no list and goes away", () => {
    const store = storeOver({ "scanner:hashes:listing-7": "{not json" });
    expect(savedHashList(store, LISTING, 1_000)).toBeNull();
    expect(storedRaw(store, "scanner:hashes:listing-7")).toBeNull();
  });

  test("a stored null or number counts as no list and goes away", () => {
    const nullSlot = storeOver({ "scanner:hashes:listing-7": "null" });
    expect(savedHashList(nullSlot, LISTING, 1_000)).toBeNull();
    expect(storedRaw(nullSlot, "scanner:hashes:listing-7")).toBeNull();
    const numberSlot = storeOver({ "scanner:hashes:listing-7": "42" });
    expect(savedHashList(numberSlot, LISTING, 1_000)).toBeNull();
    expect(storedRaw(numberSlot, "scanner:hashes:listing-7")).toBeNull();
  });

  test("a list saved after now is past its twelve hours and goes away", () => {
    const store = storeOver({
      "scanner:hashes:listing-7": '{"hashes":["aa"],"savedAt":2000}',
    });
    expect(savedHashList(store, LISTING, 1_000)).toBeNull();
    expect(storedRaw(store, "scanner:hashes:listing-7")).toBeNull();
  });

  test("a door with no saved list answers nothing", () => {
    expect(savedHashList(storeOver(), LISTING, 1_000)).toBeNull();
  });

  test("one door's saved list and queue stay out of another door's slots", () => {
    const store = storeOver();
    const group = { id: 12, kind: "group" } as const;
    saveHashList(store, LISTING, ["aa"], 1_000);
    saveHashList(store, group, ["bb"], 1_000);
    queueCheckIn(store, LISTING, "aa", 1_000);
    expect(savedHashList(store, group, 1_000)).toEqual(new Set(["bb"]));
    expect(queuedHashes(store, group)).toEqual([]);
    expect(queuedHashes(store, LISTING)).toEqual(["aa"]);
  });

  test("the saved list, the queue, and the switch survive a new page over the same storage", () => {
    const backing: Record<string, string> = {};
    const firstVisit = storeOver(backing);
    saveHashList(firstVisit, LISTING, ["aa"], 1_000);
    queueCheckIn(firstVisit, LISTING, "aa", 1_000);
    setOfflineMode(firstVisit, LISTING, true);

    const reopened = storeOver(backing);
    expect(savedHashList(reopened, LISTING, 2_000)).toEqual(new Set(["aa"]));
    expect(queuedCheckIns(firstVisit, LISTING)).toEqual([
      { operationId: expect.any(String), queuedAt: 1_000, tokenHash: "aa" },
    ]);
    expect(queuedCheckIns(reopened, LISTING)).toEqual(
      queuedCheckIns(firstVisit, LISTING),
    );
    expect(offlineModeOn(reopened, LISTING)).toBe(true);
  });

  test("an expired saved list leaves a queued check-in queued", () => {
    const store = storeOver();
    saveHashList(store, LISTING, ["aa"], 1_000);
    queueCheckIn(store, LISTING, "aa", 1_000);
    expect(
      savedHashList(store, LISTING, 1_000 + TWELVE_HOURS_MS + 1),
    ).toBeNull();
    expect(queuedHashes(store, LISTING)).toEqual(["aa"]);
  });

  test("queues every scan, oldest first, one delivery id each", () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "aa", 1_000);
    queueCheckIn(store, LISTING, "bb", 2_000);
    // A repeat scan of one ticket queues again: the party's next arrival is
    // a new delivery, and the server admits the next place.
    queueCheckIn(store, LISTING, "aa", 3_000);
    expect(queuedHashes(store, LISTING)).toEqual(["aa", "bb", "aa"]);
    const ids = queuedCheckIns(store, LISTING).map(
      (checkIn) => checkIn.operationId,
    );
    expect(new Set(ids).size).toBe(3);
  });

  test("the queue answers oldest first whatever order the scans queued", () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "bb", 2_000);
    queueCheckIn(store, LISTING, "aa", 1_000);
    expect(queuedHashes(store, LISTING)).toEqual(["aa", "bb"]);
  });

  test("a repeat scan queues its own delivery beside the first", () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "aa", 1_000);
    const firstRead = queuedCheckIns(store, LISTING);
    queueCheckIn(store, LISTING, "aa", 2_000);
    const [first, second] = queuedCheckIns(store, LISTING);
    expect(second).toEqual({
      operationId: expect.any(String),
      queuedAt: 2_000,
      tokenHash: "aa",
    });
    expect(second!.operationId).not.toBe(first!.operationId);
    // The second queueing wrote its own key and left the first delivery's
    // slot byte for byte as it was.
    expect(first).toEqual(firstRead[0]);
  });

  test("a queued check-in carries a delivery id the server accepts", () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "aa", 1_000);
    // The scan API caps a queued delivery's operation id at 100 characters.
    const ids = queuedCheckIns(store, LISTING).map(
      (checkIn) => checkIn.operationId,
    );
    expect(ids).toEqual([expect.stringMatching(/^.{1,100}$/)]);
  });

  test("drops only the delivered check-in, by its delivery id", () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "aa", 1_000);
    queueCheckIn(store, LISTING, "bb", 2_000);
    queueCheckIn(store, LISTING, "aa", 3_000);
    const [firstDelivery] = queuedCheckIns(store, LISTING);
    dropQueuedCheckIn(store, LISTING, firstDelivery!.operationId);
    // The second queued check-in of the same digest waits for its own
    // delivery, and the other digest's check-in waits too.
    expect(queuedHashes(store, LISTING)).toEqual(["bb", "aa"]);
  });

  test("two page visits queue over one storage without losing a check-in", () => {
    const backing: Record<string, string> = {};
    const firstVisit = storeOver(backing);
    const secondVisit = storeOver(backing);
    expect(queueCheckIn(firstVisit, LISTING, "aa", 1_000)).toBeUndefined();
    const valuesAfterFirstVisit = Object.values(backing);
    expect(queueCheckIn(secondVisit, LISTING, "bb", 2_000)).toBeUndefined();
    // The second visit added its own slot and left the first visit's slot
    // byte for byte as it was.
    expect(Object.keys(backing)).toHaveLength(valuesAfterFirstVisit.length + 1);
    for (const value of valuesAfterFirstVisit) {
      expect(Object.values(backing)).toContain(value);
    }
    expect(queuedHashes(secondVisit, LISTING)).toEqual(["aa", "bb"]);
    expect(queuedHashes(firstVisit, LISTING)).toEqual(["aa", "bb"]);
  });

  test("dropping one visit's delivery leaves the other visit's check-in queued", () => {
    const backing: Record<string, string> = {};
    const firstVisit = storeOver(backing);
    const secondVisit = storeOver(backing);
    // Two visits queue one ticket while offline. The first visit's replay
    // delivers, and the second visit's check-in waits for its own answer.
    queueCheckIn(firstVisit, LISTING, "aa", 1_000);
    queueCheckIn(secondVisit, LISTING, "aa", 2_000);
    const valuesBeforeDrop = Object.values(backing);
    const [firstDelivery] = queuedCheckIns(firstVisit, LISTING);
    dropQueuedCheckIn(secondVisit, LISTING, firstDelivery!.operationId);
    expect(queuedHashes(secondVisit, LISTING)).toEqual(["aa"]);
    // The drop removed the delivered check-in's own key and touched no
    // other slot, so the surviving entry keeps its stored bytes.
    expect(Object.keys(backing)).toHaveLength(valuesBeforeDrop.length - 1);
    for (const value of Object.values(backing)) {
      expect(valuesBeforeDrop).toContain(value);
    }
  });

  test("a queued entry a previous version wrote wrong reads as absent and goes away", () => {
    const junk = storeOver({ "scanner:queue:listing-7:op-1": "{not json" });
    expect(queuedCheckIns(junk, LISTING)).toEqual([]);
    expect(storedRaw(junk, "scanner:queue:listing-7:op-1")).toBeNull();
    const notARecord = storeOver({
      "scanner:queue:listing-7:op-1": '"aa"',
    });
    expect(queuedCheckIns(notARecord, LISTING)).toEqual([]);
    const halfRecord = storeOver({
      "scanner:queue:listing-7:op-1": '{"tokenHash":"aa"}',
    });
    expect(queuedCheckIns(halfRecord, LISTING)).toEqual([]);
    const noMoment = storeOver({
      "scanner:queue:listing-7:op-1": '{"tokenHash":"aa","operationId":"op-1"}',
    });
    expect(queuedCheckIns(noMoment, LISTING)).toEqual([]);
    expect(storedRaw(noMoment, "scanner:queue:listing-7:op-1")).toBeNull();
    const oldSlotShape = storeOver({
      "scanner:queue:listing-7": '["aa","bb"]',
    });
    expect(queuedCheckIns(oldSlotShape, LISTING)).toEqual([]);
  });

  test("the manual switch defaults to off and clears on turn-off", () => {
    const store = storeOver();
    expect(offlineModeOn(store, LISTING)).toBe(false);
    setOfflineMode(store, LISTING, true);
    expect(offlineModeOn(store, LISTING)).toBe(true);
    expect(storedRaw(store, "scanner:offline:listing-7")).toBe("on");
    setOfflineMode(store, LISTING, false);
    expect(offlineModeOn(store, LISTING)).toBe(false);
    expect(storedRaw(store, "scanner:offline:listing-7")).toBeNull();
  });
});
