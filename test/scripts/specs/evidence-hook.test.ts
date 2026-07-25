import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  captureScenarioEvidence,
  EVIDENCE_HOOK_TIMEOUT_MS,
} from "#scripts/specs/evidence/hook.ts";
import {
  enforceTransactionRoundTripGuard,
  runWithQueryLogContext,
  setN1GuardNotifyOnly,
  TRANSACTION_ROUNDTRIP_THRESHOLD,
} from "#shared/db/query-log.ts";

const world = {
  attach: () => Promise.resolve(),
  evidenceValues: new Map<string, string>(),
};

const hook = {
  gherkinDocument: { comments: [] },
  pickle: {
    astNodeIds: [],
    id: "pickle",
    language: "en",
    name: "Scenario",
    steps: [],
    tags: [],
    uri: "specs/example.feature",
  },
};

describe("Cucumber evidence hook", () => {
  test("allows the browser capture two minutes to finish", () => {
    expect(EVIDENCE_HOOK_TIMEOUT_MS).toBe(120_000);
  });

  test("does not load browser capture outside evidence mode", async () => {
    let loads = 0;
    await captureScenarioEvidence(world, hook, undefined, async () => {
      loads++;
      return () => Promise.resolve();
    });

    expect(loads).toBe(0);
  });

  test("loads and runs capture in evidence mode", async () => {
    const calls: unknown[] = [];
    await captureScenarioEvidence(world, hook, "1", () =>
      Promise.resolve((receivedWorld, receivedHook) => {
        calls.push(receivedWorld, receivedHook);
        return Promise.resolve();
      }),
    );

    expect(calls).toEqual([world, hook]);
  });
});

// serveHandler in src/serve-app.ts flips the N+1 guard to notify-only on its
// first call inside the loopback capture server. specs:evidence runs serially
// in one isolate (parallel: 0), so the flip would leak to later scenarios and
// silence their N+1 checks. captureScenarioEvidence's cleanup must restore the
// default throw mode. The check below uses the public transaction guard, which
// shares the same reportGuardViolation path as the N+1 read guard.
const expectGuardThrowsOnN1Violation = (): void =>
  runWithQueryLogContext(() => {
    expect(() =>
      enforceTransactionRoundTripGuard(
        TRANSACTION_ROUNDTRIP_THRESHOLD + 1,
        "SELECT 1",
      ),
    ).toThrow(/Interactive transaction too chatty/);
  });

describe("Cucumber evidence hook restores the N+1 guard after capture", () => {
  beforeEach(() => setN1GuardNotifyOnly(null));
  afterEach(() => setN1GuardNotifyOnly(null));

  test("restores the default throw mode after a successful capture", async () => {
    setN1GuardNotifyOnly(true);

    await captureScenarioEvidence(world, hook, "1", () =>
      Promise.resolve(() => Promise.resolve()),
    );

    expectGuardThrowsOnN1Violation();
  });

  test("restores the default throw mode even when the capture itself throws", async () => {
    setN1GuardNotifyOnly(true);

    await expect(
      captureScenarioEvidence(world, hook, "1", () =>
        Promise.resolve(() => Promise.reject(new Error("capture boom"))),
      ),
    ).rejects.toThrow("capture boom");

    expectGuardThrowsOnN1Violation();
  });
});
