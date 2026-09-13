import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import type { Browser, CDPSession } from "playwright";
import { stopScratchBrowser } from "#e2e/stop-browser.ts";

type Stage = "close" | "session" | "send";
type Settlement = "resolve" | "reject";
type Outcome =
  | { kind: "pending" | "completed" }
  | { error: unknown; kind: "failed" };

const stages = [
  { calls: ["close"], deadline: 10_000, stage: "close" },
  { calls: ["close", "session"], deadline: 5_000, stage: "session" },
  {
    calls: ["close", "session", "Browser.close"],
    deadline: 5_000,
    stage: "send",
  },
] as const;
const completed = { kind: "completed" } as const;
const failed = {
  error: new Error(
    "Chromium did not close after the bounded graceful close and CDP Browser.close",
  ),
  kind: "failed",
};

const advance = async (time: FakeTime, ms: number): Promise<void> => {
  await time.tickAsync(ms);
  await time.runMicrotasks();
};

const startAt = async (time: FakeTime, stage: Stage) => {
  const close = Promise.withResolvers<void>();
  const session = Promise.withResolvers<CDPSession>();
  const send = Promise.withResolvers<void>();
  const calls: string[] = [];
  const state: { connected: boolean; outcome: Outcome } = {
    connected: true,
    outcome: { kind: "pending" },
  };
  const cdp = {
    send: (method: string) => {
      calls.push(method);
      return send.promise;
    },
  } as unknown as CDPSession;
  const browser = {
    close: () => {
      calls.push("close");
      return close.promise;
    },
    isConnected: () => state.connected,
    newBrowserCDPSession: () => {
      calls.push("session");
      return session.promise;
    },
  } as Browser;
  // Start the shutdown without awaiting it, and record how it ends: the
  // test drives fake time while the run is in flight.
  const recordOutcome = async (): Promise<void> => {
    try {
      await stopScratchBrowser(browser);
      state.outcome = completed;
    } catch (error: unknown) {
      state.outcome = { error, kind: "failed" };
    }
  };
  void recordOutcome();
  if (stage !== "close") close.resolve();
  if (stage === "send") session.resolve(cdp);
  await advance(time, 0);
  const operations = { close, send, session };
  const settle = (target: Stage, settlement: Settlement): void => {
    if (settlement === "reject") {
      operations[target].reject(new Error("operation failed"));
    } else if (target === "session") {
      session.resolve(cdp);
    } else {
      operations[target].resolve();
    }
  };
  const expectFinished = (): void => {
    // A state assertion fails without a hang if shutdown never settles.
    expect(state.outcome).toEqual(state.connected ? failed : completed);
    expect(time.next()).toBe(false);
  };
  return { calls, cdp, expectFinished, send, session, settle, state };
};

describe("stopScratchBrowser", () => {
  for (const { calls, deadline, stage } of stages) {
    for (const connected of [true, false]) {
      test(`${stage} timeout, connected=${connected}`, async () => {
        using time = new FakeTime();
        const browser = await startAt(time, stage);
        expect(browser.calls).toEqual(calls);
        await advance(time, deadline - 1);
        expect(browser.state.outcome).toEqual({ kind: "pending" });
        expect(browser.calls).toEqual(calls);

        browser.state.connected = connected;
        await advance(time, 1);
        if (stage === "close" && connected) {
          expect(browser.calls).toEqual(["close", "session"]);
          expect(browser.state.outcome).toEqual({ kind: "pending" });
          browser.session.resolve(browser.cdp);
          browser.send.resolve();
          await advance(time, 0);
          expect(browser.calls).toEqual(["close", "session", "Browser.close"]);
        } else {
          expect(browser.calls).toEqual(calls);
        }
        browser.expectFinished();

        // Deno fails the test if this late rejection escapes its handler.
        browser.settle(stage, "reject");
        await time.runMicrotasks();
        browser.expectFinished();
      });
    }

    for (const settlement of ["resolve", "reject"] as const) {
      for (const connected of [true, false]) {
        test(`${stage} ${settlement}, connected=${connected}`, async () => {
          using time = new FakeTime();
          const browser = await startAt(time, stage);
          browser.state.connected = connected;
          browser.settle(stage, settlement);
          await advance(time, 0);

          const fallback =
            connected &&
            (stage === "close" ||
              (stage === "session" && settlement === "resolve"));
          if (fallback) {
            expect(browser.state.outcome).toEqual({ kind: "pending" });
            browser.session.resolve(browser.cdp);
            await advance(time, 0);
            expect(browser.calls).toEqual([
              "close",
              "session",
              "Browser.close",
            ]);
            browser.send.resolve();
            await advance(time, 0);
          } else {
            expect(browser.calls).toEqual(calls);
          }
          browser.expectFinished();
        });
      }
    }
  }

  for (const sessionArrives of [true, false]) {
    test(`late session before deadline=${sessionArrives}`, async () => {
      using time = new FakeTime();
      const browser = await startAt(time, "close");
      await advance(time, 10_000);
      expect(browser.calls).toEqual(["close", "session"]);
      await advance(time, 4_999);
      if (sessionArrives) {
        browser.settle("session", "resolve");
        await advance(time, 0);
        expect(browser.calls).toEqual(["close", "session", "Browser.close"]);
        await advance(time, 4_999);
      }
      expect(browser.state.outcome).toEqual({ kind: "pending" });
      await advance(time, 1);
      browser.expectFinished();

      browser.settle("close", "resolve");
      browser.settle("session", "resolve");
      browser.settle("send", "resolve");
      await time.runMicrotasks();
      expect(browser.calls).toEqual(
        sessionArrives
          ? ["close", "session", "Browser.close"]
          : ["close", "session"],
      );
      browser.expectFinished();
    });
  }
});
