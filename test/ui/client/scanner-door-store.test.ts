/** The scanner door's offline store: the saved digest list, the queue, the
 * switch, and the replay run. Pure store rules over a plain object; the
 * browser wiring around them is covered by the built-bundle tests. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  dropQueuedCheckIn,
  interpolate,
  type KeyValueStore,
  offlineModeOn,
  queueCheckIn,
  queuedCheckInHashes,
  replayGate,
  replayQueuedCheckIns,
  type ScanAnswer,
  type ScanMessages,
  type ScanPost,
  savedHashList,
  saveHashList,
  scopeFromTokensPath,
  setOfflineMode,
  strictScannerPost,
} from "#src/ui/client/scanner-door-store.ts";

const LISTING = { id: 7, kind: "listing" } as const;

/** Twelve hours, the longest a saved list may answer scans. */
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

/** A plain-object store, so each test reads the door's slots back exactly
 * as they were written. */
const storeOver = (initial: Record<string, string> = {}): KeyValueStore => {
  const data: Record<string, string> = { ...initial };
  return {
    getItem: (key) => data[key] ?? null,
    removeItem: (key) => delete data[key],
    setItem: (key, value) => {
      data[key] = value;
    },
  };
};

/** The stored digest list the tests read raw, key and all. */
const storedRaw = (store: KeyValueStore, key: string): string | null =>
  store.getItem(key);

/** A replay's one admission, recorded so a test can answer or refuse. */
const admissionOf = (
  refusals: ReadonlyMap<string, Error>,
): {
  admits: (
    tokenHash: string,
    post: ScanPost,
    messages: ScanMessages,
  ) => Promise<void>;
  asked: string[];
} => {
  const asked: string[] = [];
  return {
    admits: (tokenHash) => {
      asked.push(tokenHash);
      const refusal = refusals.get(tokenHash);
      return refusal !== undefined
        ? Promise.reject(refusal)
        : Promise.resolve();
    },
    asked,
  };
};

/** The replay deps a store test runs: one recorded admission and one post
 * that always answers checked_in. */
const replayDeps = (
  store: KeyValueStore,
  admitOne: (
    tokenHash: string,
    post: ScanPost,
    messages: ScanMessages,
  ) => Promise<void>,
) => ({
  admitOne,
  messages: {},
  post: () => Promise.resolve({ status: "checked_in" }) as Promise<ScanAnswer>,
  scope: LISTING,
  store,
});

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

  test("junk in the saved slot counts as no list and goes away", () => {
    const store = storeOver({ "scanner:hashes:listing-7": "{not json" });
    expect(savedHashList(store, LISTING, 1_000)).toBeNull();
    expect(storedRaw(store, "scanner:hashes:listing-7")).toBeNull();
  });

  test("a door with no saved list answers nothing", () => {
    expect(savedHashList(storeOver(), LISTING, 1_000)).toBeNull();
  });

  test("queues one check-in per digest, oldest first", () => {
    const store = storeOver();
    expect(queueCheckIn(store, LISTING, "aa")).toBe(true);
    expect(queueCheckIn(store, LISTING, "bb")).toBe(true);
    expect(queueCheckIn(store, LISTING, "aa")).toBe(false);
    expect(queuedCheckInHashes(store, LISTING)).toEqual(["aa", "bb"]);
  });

  test("drops exactly the delivered digest", () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "aa");
    queueCheckIn(store, LISTING, "bb");
    dropQueuedCheckIn(store, LISTING, "aa");
    expect(queuedCheckInHashes(store, LISTING)).toEqual(["bb"]);
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

  test("fills the message holes and leaves unknown ones empty", () => {
    expect(
      interpolate("{name} has {count} tickets", { count: 2, name: "Ada" }),
    ).toBe("Ada has 2 tickets");
    expect(interpolate("{gone}", {})).toBe("");
  });

  test("a replay trusts only real scan answers, choices included", async () => {
    const seen: unknown[] = [];
    const post = strictScannerPost((...args) => {
      seen.push(args);
      return Promise.resolve({ status: "checked_in" } as ScanAnswer);
    });
    await expect(post("/scan", "aa", "csrf", { quantity: 2 })).resolves.toEqual(
      { status: "checked_in" },
    );
    expect(seen).toEqual([["/scan", "aa", "csrf", { quantity: 2 }]]);
    await expect(post("/scan", "aa", "csrf", undefined)).resolves.toEqual({
      status: "checked_in",
    });
  });

  test("a replay stops cold on a body no scan API speaks", async () => {
    const post = strictScannerPost(() =>
      Promise.resolve({ signed_in: true } as unknown as ScanAnswer),
    );
    await expect(post("/scan", "aa", "csrf")).rejects.toThrow(
      /Not a scan answer/,
    );
  });

  test("sends every queued check-in once, oldest first", async () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "aa");
    queueCheckIn(store, LISTING, "bb");
    const { admits, asked } = admissionOf(new Map());

    const result = await replayQueuedCheckIns(replayDeps(store, admits));

    expect(asked).toEqual(["aa", "bb"]);
    expect(result).toEqual({ sent: 2, waiting: 0 });
    expect(queuedCheckInHashes(store, LISTING)).toEqual([]);
  });

  test("stops at the first send that cannot land and keeps the rest", async () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "aa");
    queueCheckIn(store, LISTING, "bb");
    queueCheckIn(store, LISTING, "cc");
    const { admits, asked } = admissionOf(
      new Map([["bb", new Error("no connection")]]),
    );

    const result = await replayQueuedCheckIns(replayDeps(store, admits));

    expect(asked).toEqual(["aa", "bb"]);
    expect(result).toEqual({ sent: 1, waiting: 2 });
    expect(queuedCheckInHashes(store, LISTING)).toEqual(["bb", "cc"]);
  });

  test("a second replay trigger stands down while one runs", async () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "aa");
    const { promise, resolve } = Promise.withResolvers<void>();
    const gate = replayGate();
    const deps = {
      admitOne: () => promise,
      messages: {},
      post: () =>
        Promise.resolve({ status: "checked_in" }) as Promise<ScanAnswer>,
      scope: LISTING,
      store,
    };
    const first = gate.run(deps);

    expect(gate.replaying()).toBe(true);
    expect(await gate.run(deps)).toBeNull();

    resolve();
    expect(await first).toEqual({ sent: 1, waiting: 0 });
    expect(gate.replaying()).toBe(false);
  });
});
