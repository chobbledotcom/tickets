import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  enforceTransactionRoundTripGuard,
  runWithQueryLogContext,
  setN1GuardNotifyOnly,
  TRANSACTION_ROUNDTRIP_THRESHOLD,
} from "#db/query-log.ts";
import {
  captureScenarioEvidence,
  EVIDENCE_HOOK_TIMEOUT_MS,
} from "#scripts/specs/evidence/hook.ts";

const world = {
  attach: () => Promise.resolve(),
  evidenceCookies: new Map<string, string>(),
  evidencePages: new Map<string, string>(),
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

// The checks below use the public transaction guard, which shares the same
// reportGuardViolation path as the N+1 read guard.
const expectGuardThrowsOnN1Violation = (): void =>
  runWithQueryLogContext(() => {
    expect(() =>
      enforceTransactionRoundTripGuard(
        TRANSACTION_ROUNDTRIP_THRESHOLD + 1,
        "SELECT 1",
      ),
    ).toThrow(/Interactive transaction too chatty/);
  });

const expectGuardAllowsN1Violation = async (): Promise<void> => {
  await runWithQueryLogContext(async () => {
    expect(() =>
      enforceTransactionRoundTripGuard(
        TRANSACTION_ROUNDTRIP_THRESHOLD + 1,
        "SELECT 1",
      ),
    ).not.toThrow();
    // Let the notify-only logger finish before its console stub is restored.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe("Cucumber evidence hook restores the N+1 guard after capture", () => {
  beforeEach(() => setN1GuardNotifyOnly(null));
  afterEach(() => setN1GuardNotifyOnly(null));

  test("enables notify-only mode for every capture", async () => {
    using _consoleError = stub(console, "error");
    const loadCapture = () => Promise.resolve(expectGuardAllowsN1Violation);

    await captureScenarioEvidence(world, hook, "1", loadCapture);
    await captureScenarioEvidence(world, hook, "1", loadCapture);
  });

  test("restores the default throw mode after a successful capture", async () => {
    await captureScenarioEvidence(world, hook, "1", () =>
      Promise.resolve(() => Promise.resolve()),
    );

    expectGuardThrowsOnN1Violation();
  });

  test("restores the default throw mode even when the capture itself throws", async () => {
    await expect(
      captureScenarioEvidence(world, hook, "1", () =>
        Promise.resolve(() => Promise.reject(new Error("capture boom"))),
      ),
    ).rejects.toThrow("capture boom");

    expectGuardThrowsOnN1Violation();
  });
});
