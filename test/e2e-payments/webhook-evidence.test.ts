/**
 * The webhook-evidence step builder, against a fake world and a real log
 * file: the success path reads the webhook route's own line, the held path
 * records a delivery that another request took, and a log without the
 * webhook's line fails the step loudly. FakeTime drives the 90s confirm
 * window, so no test waits for it.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { webhookEvidenceThen } from "#e2e/cucumber/steps/webhook-evidence.ts";
import type { LiveWorld } from "#e2e/cucumber/support/world.ts";

/** A world whose server log lives at logPath, recording the phases it is told. */
const worldWithLog = (
  logPath: string,
): { phases: string[]; world: LiveWorld } => {
  const phases: string[] = [];
  const world = {
    recordPhase: (phase: string) => {
      phases.push(phase);
    },
    resources: { server: { logPath } },
  } as unknown as LiveWorld;
  return { phases, world };
};

const writeLog = async (line: string): Promise<string> => {
  const logPath = await Deno.makeTempFile();
  await Deno.writeTextFile(logPath, `${line}\n`);
  return logPath;
};

describe("webhookEvidenceThen", () => {
  test("the step's own outcome proves the webhook did the work", async () => {
    const logPath = await writeLog("[Webhook] Payment callback booked");
    try {
      const { phases, world } = worldWithLog(logPath);
      await webhookEvidenceThen("booked")(world);
      expect(phases).toEqual(["webhook-booked"]);
    } finally {
      await Deno.remove(logPath);
    }
  });

  test("a settled-without-booking delivery proves the terminalized outcome", async () => {
    const logPath = await writeLog(
      "[Webhook] Payment callback settled without a booking",
    );
    try {
      const { phases, world } = worldWithLog(logPath);
      await webhookEvidenceThen("terminalized")(world);
      expect(phases).toEqual(["webhook-terminalized"]);
    } finally {
      await Deno.remove(logPath);
    }
  });

  test("a held delivery is recorded under its own name", async () => {
    using time = new FakeTime();
    const logPath = await writeLog(
      "[Webhook] Payment callback is being processed elsewhere",
    );
    try {
      const { phases, world } = worldWithLog(logPath);
      const step = webhookEvidenceThen("booked")(world);
      await time.tickAsync(90_000);
      await time.runMicrotasks();
      await step;
      expect(phases).toEqual(["webhook-held-by-another-request"]);
    } finally {
      await Deno.remove(logPath);
    }
  });

  test("a log without the webhook's own line fails the step loudly", async () => {
    using time = new FakeTime();
    const { phases, world } = worldWithLog("/nonexistent/app-server.log");
    const step = webhookEvidenceThen("terminalized")(world);
    const failure = expect(step).rejects.toThrow(
      "the app server log carries no '[Webhook] Payment callback settled without a booking' line",
    );
    await time.tickAsync(90_000);
    await time.runMicrotasks();
    await failure;
    expect(phases).toEqual([]);
  });
});
