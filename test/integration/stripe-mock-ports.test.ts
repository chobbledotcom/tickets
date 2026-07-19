import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stripeMock } from "#shared/stripe/mock.ts";
import {
  STRIPE_MOCK_FAILED_TO_START,
  startStripeMock,
  stripeMockEnv,
  stripeMockPortFromEnv,
} from "../../scripts/stripe-mock.ts";
import {
  expectPortAvailable,
  expectPortOpen,
  expectStripeMockFails,
  keepPortOpenCommand,
  testEnv,
  withHeldPort,
  withTempStripeMockPaths,
  withUnusedPort,
  writeFailingMock,
  writePortThief,
  writeTermIgnoringMock,
} from "../lib/stripe-mock/helpers.ts";

describe("stripe-mock ports and environment", () => {
  test("uses the default port when the env var is absent", () => {
    expect(stripeMockPortFromEnv(testEnv({}))).toBe(stripeMock.defaultPort);
  });

  test("uses the explicit port from the env var", () => {
    expect(stripeMockPortFromEnv(testEnv({ STRIPE_MOCK_PORT: "12345" }))).toBe(
      12345,
    );
  });

  test("rejects invalid env ports", () => {
    expect(() =>
      stripeMockPortFromEnv(testEnv({ STRIPE_MOCK_PORT: "abc" })),
    ).toThrow("STRIPE_MOCK_PORT must be a number from 1 to 65535");
  });

  test("builds the child-process stripe-mock environment", () => {
    expect(stripeMockEnv(12345)).toEqual({
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      STRIPE_MOCK_HOST: "localhost",
      STRIPE_MOCK_PORT: "12345",
    });
  });
});

describe("startStripeMock ports", () => {
  test("returns a no-op handle when the port is already running", async () => {
    const port = stripeMockPortFromEnv();
    const stripeMock = await startStripeMock({ port });

    expect(stripeMock.port).toBe(port);
    stripeMock.stopNow();
    await stripeMock.stop();
    await expectPortOpen(port);
  });

  test("starts and stops a managed mock on an explicit port", async () => {
    await withUnusedPort(async (port) => {
      const stripeMock = await startStripeMock({ port });

      try {
        expect(stripeMock.port).toBe(port);
        await expectPortOpen(port);
      } finally {
        await stripeMock.stop();
      }

      expectPortAvailable(port);
    });
  });

  test("has synchronous cleanup for raw setup unload", async () => {
    await withUnusedPort(async (port) => {
      const stripeMock = await startStripeMock({ port });
      expect(stripeMock.port).toBe(port);
      await expectPortOpen(port);

      stripeMock.stopNow();
      await stripeMock.stop();
      stripeMock.stopNow();
      expectPortAvailable(port);
    });
  });

  test("uses STRIPE_MOCK_PORT when no explicit port is passed", async () => {
    await withUnusedPort(async (port) => {
      const stripeMock = await startStripeMock({
        env: testEnv({ STRIPE_MOCK_PORT: String(port) }),
      });

      try {
        expect(stripeMock.port).toBe(port);
        await expectPortOpen(port);
      } finally {
        await stripeMock.stop();
      }
    });
  });

  test("chooses a free port when STRIPE_MOCK_PORT is absent", async () => {
    const stripeMock = await startStripeMock({ env: testEnv({}) });

    try {
      expect(stripeMock.port).toBeGreaterThan(0);
      await expectPortOpen(stripeMock.port);
    } finally {
      await stripeMock.stop();
    }
  });

  test("retries instead of adopting an auto-selected taken port", async () => {
    await withHeldPort(async (port) => {
      await expect(
        startStripeMock({
          choosePort: () => port,
          env: testEnv({}),
          startAttempts: 1,
        }),
      ).rejects.toThrow(STRIPE_MOCK_FAILED_TO_START);
    });
  });

  test("does not accept another listener when the spawned mock exits", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await writePortThief(paths);
      await expectStripeMockFails({
        confirmDelayMs: 20,
        delayMs: 10,
        maxAttempts: 20,
        paths,
      });
    });
  });

  test("surfaces stderr when the spawned mock fails", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await writeFailingMock(paths, "wrong binary");
      await expectStripeMockFails(
        {
          delayMs: 10,
          maxAttempts: 10,
          paths,
        },
        `${STRIPE_MOCK_FAILED_TO_START}: wrong binary`,
      );
    });
  });

  test("retries an auto-selected port when the spawned mock exits", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await writePortThief(paths, false, keepPortOpenCommand);
      const stripeMock = await startStripeMock({
        confirmDelayMs: 100,
        delayMs: 20,
        env: testEnv({}),
        maxAttempts: 100,
        paths,
        startAttempts: 3,
      });

      try {
        expect(stripeMock.port).toBeGreaterThan(0);
        await expectPortOpen(stripeMock.port);
      } finally {
        await stripeMock.stop();
      }
    });
  });

  test("kills an unresponsive managed mock on stop", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await writeTermIgnoringMock(paths);
      await withUnusedPort(async (port) => {
        const stripeMock = await startStripeMock({
          confirmDelayMs: 50,
          delayMs: 10,
          maxAttempts: 100,
          paths,
          port,
          stopTimeoutMs: 50,
        });

        expect(stripeMock.port).toBe(port);
        await expectPortOpen(port);
        await stripeMock.stop();
        await expect(
          Deno.connect({ hostname: "127.0.0.1", port }),
        ).rejects.toThrow();
      });
    });
  });
});
