/** The scanner offline rules: the saved ticket list, the queue, the switch,
 * and the replay run. Pure store rules over a plain object; the browser
 * wiring around them is covered by the built-bundle tests. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  dropQueuedCheckIn,
  interpolate,
  type KeyValueStore,
  offlineModeOn,
  queueCheckIn,
  queuedCheckIns,
  replayQueuedCheckIns,
  runReplay,
  type ScanAnswer,
  savedTokenList,
  saveTokenList,
  scopeFromTokensPath,
  setOfflineMode,
  strictScannerPost,
} from "#src/ui/client/scanner-offline.ts";

const LISTING = { id: 7, kind: "listing" } as const;

/** A plain-object store, so each test reads the door's slots back exactly
 * as they were written. */
const storeOver = (initial: Record<string, string> = {}): KeyValueStore => {
  const data: Record<string, string> = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key]! : null),
    removeItem: (key) => {
      delete data[key];
    },
    setItem: (key, value) => {
      data[key] = value;
    },
  };
};

describe("the scanner offline rules", () => {
  test("reads the door scope out of the token path", () => {
    expect(scopeFromTokensPath("/admin/listing/7/scan-tokens")).toEqual({
      id: 7,
      kind: "listing",
    });
    expect(scopeFromTokensPath("/admin/groups/12/scan-tokens")).toEqual({
      id: 12,
      kind: "group",
    });
    expect(() => scopeFromTokensPath("/admin/listing/7/scan")).toThrow(
      /No door scope/,
    );
  });

  test("saves the token list once, sorted and unique", () => {
    const store = storeOver();
    saveTokenList(store, LISTING, ["BBBB", "AAAA", "BBBB"]);
    expect(savedTokenList(store, LISTING)).toEqual(new Set(["AAAA", "BBBB"]));
  });

  test("junk in the saved slot counts as no list", () => {
    expect(
      savedTokenList(storeOver({ "scanner:tokens:listing-7": "42" }), LISTING),
    ).toEqual(new Set());
    expect(
      savedTokenList(
        storeOver({ "scanner:tokens:listing-7": '["AAAA", 3, null]' }),
        LISTING,
      ),
    ).toEqual(new Set(["AAAA"]));
  });

  test("queues one check-in per token, oldest first", () => {
    const store = storeOver();
    expect(queueCheckIn(store, LISTING, "AAAA")).toBe(true);
    expect(queueCheckIn(store, LISTING, "BBBB")).toBe(true);
    expect(queueCheckIn(store, LISTING, "AAAA")).toBe(false);
    expect(queuedCheckIns(store, LISTING)).toEqual(["AAAA", "BBBB"]);
  });

  test("drops exactly the delivered token", () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "AAAA");
    queueCheckIn(store, LISTING, "BBBB");
    dropQueuedCheckIn(store, LISTING, "AAAA");
    expect(queuedCheckIns(store, LISTING)).toEqual(["BBBB"]);
  });

  test("the manual switch defaults to off and clears on turn-off", () => {
    const store = storeOver();
    expect(offlineModeOn(store, LISTING)).toBe(false);
    setOfflineMode(store, LISTING, true);
    expect(offlineModeOn(store, LISTING)).toBe(true);
    setOfflineMode(store, LISTING, false);
    expect(store.getItem("scanner:offline:listing-7")).toBeNull();
    expect(offlineModeOn(store, LISTING)).toBe(false);
  });

  test("fills the message holes and leaves unknown ones empty", () => {
    expect(
      interpolate("{name} has {count} tickets", { count: 2, name: "Pia" }),
    ).toBe("Pia has 2 tickets");
    expect(interpolate("Hello {missing}", {})).toBe("Hello ");
  });

  test("a replay trusts only real scan answers, choices included", async () => {
    const seen: unknown[][] = [];
    const post = strictScannerPost((...args) => {
      seen.push(args);
      return Promise.resolve({ status: "checked_in" });
    });
    await expect(post("/scan", "AAAA", "csrf")).resolves.toEqual({
      status: "checked_in",
    });
    await expect(
      post("/scan", "BBBB", "csrf", { quantity: 2 }),
    ).resolves.toEqual({
      status: "checked_in",
    });
    expect(seen[1]).toEqual(["/scan", "BBBB", "csrf", { quantity: 2 }]);
  });

  test("a replay stops cold on a body no scan API speaks", async () => {
    const post = strictScannerPost(
      (): Promise<ScanAnswer> =>
        Promise.resolve({ error: "forbidden" } as unknown as ScanAnswer),
    );
    await expect(post("/scan", "AAAA", "csrf")).rejects.toThrow(
      /Not a scan answer/,
    );
  });

  test("sends every queued check-in once, oldest first", async () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "AAAA");
    queueCheckIn(store, LISTING, "BBBB");
    const sent: string[] = [];
    const counts: number[] = [];
    const result = await replayQueuedCheckIns({
      admitOne: (token) => {
        sent.push(token);
        return Promise.resolve();
      },
      onQueueChange: (waiting) => counts.push(waiting),
      scope: LISTING,
      store,
    });
    expect(sent).toEqual(["AAAA", "BBBB"]);
    expect(result).toEqual({ sent: 2, waiting: 0 });
    expect(counts).toEqual([1, 0]);
    expect(queuedCheckIns(store, LISTING)).toEqual([]);
  });

  test("stops at the first send that cannot land and keeps the rest", async () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "AAAA");
    queueCheckIn(store, LISTING, "BBBB");
    let sends = 0;
    const result = await replayQueuedCheckIns({
      admitOne: () => {
        sends += 1;
        throw new Error("network down");
      },
      scope: LISTING,
      store,
    });
    expect(sends).toBe(1);
    expect(result).toEqual({ sent: 0, waiting: 2 });
    expect(queuedCheckIns(store, LISTING)).toEqual(["AAAA", "BBBB"]);
  });

  test("a second replay trigger stands down while one runs", async () => {
    const store = storeOver();
    queueCheckIn(store, LISTING, "AAAA");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runReplay({ admitOne: () => gate, scope: LISTING, store });
    expect(
      await runReplay({
        admitOne: () => Promise.resolve(),
        scope: LISTING,
        store,
      }),
    ).toBeNull();
    release();
    expect(await first).toEqual({ sent: 1, waiting: 0 });
    queueCheckIn(store, LISTING, "BBBB");
    expect(
      await runReplay({
        admitOne: () => Promise.resolve(),
        scope: LISTING,
        store,
      }),
    ).toEqual({ sent: 1, waiting: 0 });
  });
});
