/**
 * The replay's pure rules through the wiring's own exports: one replay at a
 * time, the run's outcome, the names the sync carries home, and the
 * delivery id each send rides on. The page journeys around them live in
 * `../scanner-offline.test.ts` and `sync.test.ts`.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type KeyValueStore,
  mapStoreOver,
  queueCheckIn,
  queuedCheckIns,
} from "#src/ui/client/scanner-door-store.ts";
import {
  replayGate,
  replayQueuedCheckIns,
  type ScanAnswer,
  type ScanPost,
} from "#src/ui/client/scanner-offline.ts";

const SCOPE = { id: 5, kind: "group" } as const;
const QUEUED_AT = 1_000;

const storeOver = (): {
  backing: Map<string, string>;
  store: KeyValueStore;
} => {
  const backing = new Map<string, string>();
  return { backing, store: mapStoreOver(backing) };
};

const queuedDelivery = (store: KeyValueStore, hash: string): void => {
  queueCheckIn(store, SCOPE, hash, QUEUED_AT);
};

/** One replay held until the test releases it, with the deps both triggers
 * share. */
const heldReplay = (
  gate: ReturnType<typeof replayGate>,
  store: KeyValueStore,
) => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps = {
    admitOne: async (): Promise<ScanAnswer> => {
      await held;
      return { status: "checked_in" };
    },
    messages: {},
    post: async (): Promise<ScanAnswer> => ({ status: "checked_in" }),
    scope: SCOPE,
    store,
  };
  return { deps, release, running: gate.run(deps) };
};

describe("the replay's rules", () => {
  test("a second replay trigger stands down while one runs", async () => {
    const { store } = storeOver();
    queuedDelivery(store, "aa");
    const gate = replayGate();
    const { deps, release, running } = heldReplay(gate, store);

    const second = await gate.run(deps);
    expect(second).toBeNull();
    release();
    expect(await running).toEqual({ duplicates: [], sent: 1, waiting: 0 });
  });

  test("the replay settles each check-in in turn and stops at a lost send", async () => {
    const { store, backing } = storeOver();
    queuedDelivery(store, "aa");
    queuedDelivery(store, "bb");
    const outcome = await replayQueuedCheckIns({
      admitOne: async (tokenHash) => {
        if (tokenHash === "bb") throw new Error("the server was out of reach");
        return { status: "checked_in" };
      },
      messages: {},
      post: async (): Promise<ScanAnswer> => ({ status: "checked_in" }),
      scope: SCOPE,
      store,
    });
    expect(outcome).toEqual({ duplicates: [], sent: 1, waiting: 1 });
    const waiting = queuedCheckIns(store, SCOPE);
    expect(waiting.map((delivery) => delivery.tokenHash)).toEqual(["bb"]);
    // The lost check-in keeps its own delivery id for the next run, and
    // the delivered one's slot is gone.
    expect(
      Array.from(backing.keys()).filter((key) =>
        key.startsWith("scanner:queue:group-5:"),
      ),
    ).toEqual([`scanner:queue:group-5:${waiting[0]?.operationId}`]);
  });

  test("every send of a delivery carries the delivery's own operation id", async () => {
    const { store } = storeOver();
    queuedDelivery(store, "aa");
    const delivery = queuedCheckIns(store, SCOPE)[0];
    expect(delivery?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const sentChoices: Record<string, unknown>[] = [];
    const post: ScanPost = (_scanPath, _token, _csrfToken, choices) => {
      sentChoices.push(choices ?? {});
      return Promise.resolve({ status: "checked_in" });
    };
    await replayQueuedCheckIns({
      admitOne: async (_tokenHash, wrapped) => {
        // One delivery's first send and its re-ask both go through the
        // replay's post, so both name the same delivery.
        await wrapped("/scan", "aa", "");
        return wrapped("/scan", "aa", "", { force: true });
      },
      messages: {},
      post,
      scope: SCOPE,
      store,
    });
    expect(
      sentChoices.every(
        (choices) => choices.operationId === delivery?.operationId,
      ),
    ).toBe(true);
  });

  test("the replay names every check-in the door had already taken", async () => {
    const { store } = storeOver();
    queuedDelivery(store, "aa");
    queuedDelivery(store, "bb");
    const outcome = await replayQueuedCheckIns({
      admitOne: async (_tokenHash, post) => {
        const answer = await post("/scan", "", "");
        return answer;
      },
      messages: {},
      post: async (): Promise<ScanAnswer> => ({
        name: "Ada",
        status: "already_checked_in",
      }),
      scope: SCOPE,
      store,
    });
    expect(outcome).toEqual({
      duplicates: ["Ada", "Ada"],
      sent: 2,
      waiting: 0,
    });
  });

  test("every check-in that settles repaints the door's waiting line", async () => {
    const { store } = storeOver();
    queuedDelivery(store, "aa");
    queuedDelivery(store, "bb");
    let paints = 0;
    const outcome = await replayQueuedCheckIns({
      admitOne: async (): Promise<ScanAnswer> => ({ status: "checked_in" }),
      messages: {},
      onQueueChange: () => {
        paints += 1;
      },
      post: async (): Promise<ScanAnswer> => ({ status: "checked_in" }),
      scope: SCOPE,
      store,
    });
    expect(outcome).toEqual({ duplicates: [], sent: 2, waiting: 0 });
    // One repaint per settled check-in: the line can never name a count
    // the queue no longer holds.
    expect(paints).toBe(2);
  });

  test("the gate says when a replay runs", async () => {
    const { store } = storeOver();
    queuedDelivery(store, "aa");
    const gate = replayGate();
    expect(gate.replaying()).toBe(false);
    const { release, running } = heldReplay(gate, store);
    expect(gate.replaying()).toBe(true);
    release();
    expect(await running).toEqual({ duplicates: [], sent: 1, waiting: 0 });
    expect(gate.replaying()).toBe(false);
  });
});
