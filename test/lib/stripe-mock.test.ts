import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

import {
  BIN_DIR,
  downloadStripeMock,
  getArch,
  getPlatform,
  isStripeMockRunning,
  STRIPE_MOCK_PATH,
  STRIPE_MOCK_PORT,
  StripeMockManager,
  waitForStripeMock,
} from "#test-utils/stripe-mock.ts";

describe("stripe-mock utilities", () => {
  describe("isStripeMockRunning", () => {
    test("returns true when stripe-mock is running on default port", async () => {
      // stripe-mock is started by test/setup.ts
      const running = await isStripeMockRunning();
      expect(running).toBe(true);
    });

    test("returns true when stripe-mock is running on specified port", async () => {
      const running = await isStripeMockRunning(STRIPE_MOCK_PORT);
      expect(running).toBe(true);
    });

    test("returns false for port with no server", async () => {
      // Use a port that definitely has nothing running
      const running = await isStripeMockRunning(59999);
      expect(running).toBe(false);
    });
  });

  describe("waitForStripeMock", () => {
    test("returns true immediately when stripe-mock is already running", async () => {
      const start = Date.now();
      const ready = await waitForStripeMock(STRIPE_MOCK_PORT, 30, 100);
      const elapsed = Date.now() - start;

      expect(ready).toBe(true);
      // Should return quickly since it's already running
      expect(elapsed).toBeLessThan(200);
    });

    test("returns false after timeout when server not running", async () => {
      const start = Date.now();
      // Use port with no server, minimal attempts and delay
      const ready = await waitForStripeMock(59999, 3, 10);
      const elapsed = Date.now() - start;

      expect(ready).toBe(false);
      // Should have waited at least 3 * 10ms = 30ms
      expect(elapsed).toBeGreaterThanOrEqual(20);
    });
  });

  describe("downloadStripeMock", () => {
    test("skips download when binary already exists", async () => {
      // Binary should already exist from test setup
      let exists = false;
      try {
        await Deno.stat(STRIPE_MOCK_PATH);
        exists = true;
      } catch {
        exists = false;
      }
      expect(exists).toBe(true);

      // This should return immediately without downloading
      const start = Date.now();
      await downloadStripeMock();
      const elapsed = Date.now() - start;

      // Should be very fast since it just checks existence
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe("StripeMockManager", () => {
    test("creates manager with default port", () => {
      const manager = new StripeMockManager();
      expect(manager.isManaged()).toBe(false);
    });

    test("creates manager with custom port", () => {
      const manager = new StripeMockManager(12345);
      expect(manager.isManaged()).toBe(false);
    });

    test("start returns immediately when already running on port", async () => {
      // stripe-mock is already running from test/setup.ts on default port
      const manager = new StripeMockManager(STRIPE_MOCK_PORT);

      const start = Date.now();
      await manager.start();
      const elapsed = Date.now() - start;

      // Should detect it's running and return quickly
      expect(elapsed).toBeLessThan(200);
      // Since it was already running, manager didn't start it
      expect(manager.isManaged()).toBe(false);
    });

    test("stop is safe to call when not managing a process", () => {
      const manager = new StripeMockManager();
      // Should not throw
      manager.stop();
      expect(manager.isManaged()).toBe(false);
    });

    test("stop kills managed process", async () => {
      // Start on a different port so we control the process
      const testPort = 12112;
      const manager = new StripeMockManager(testPort);

      // First ensure nothing is running on that port
      const beforeRunning = await isStripeMockRunning(testPort);
      if (beforeRunning) {
        // Skip this test if something is already on that port
        return;
      }

      try {
        await manager.start();
        expect(manager.isManaged()).toBe(true);

        // Verify it's running
        const running = await isStripeMockRunning(testPort);
        expect(running).toBe(true);

        // Stop it
        manager.stop();
        expect(manager.isManaged()).toBe(false);

        // Give it a moment to shut down
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Verify it's stopped
        const stillRunning = await isStripeMockRunning(testPort);
        expect(stillRunning).toBe(false);
      } finally {
        // Ensure cleanup even if test fails
        manager.stop();
      }
    });

    test("start downloads the binary when it is missing before spawning", async () => {
      const testPort = 12113;
      // Skip if something is already on that port
      if (await isStripeMockRunning(testPort)) return;

      const realPath = STRIPE_MOCK_PATH;
      const backupPath = `${realPath}.bak-mgr`;
      const manager = new StripeMockManager(testPort);
      let renamed = false;

      try {
        // Remove the binary so start() must download it before spawning;
        // if start() skipped the download, spawn would fail with NotFound.
        await Deno.rename(realPath, backupPath);
        renamed = true;

        await manager.start();

        expect(manager.isManaged()).toBe(true);
        expect(await isStripeMockRunning(testPort)).toBe(true);
      } finally {
        manager.stop();
        if (renamed) {
          // Discard the downloaded binary and restore the original.
          try {
            await Deno.remove(realPath);
          } catch {
            // May not exist if download failed
          }
          await Deno.rename(backupPath, realPath);
        }
      }
    });

    test("start throws when stripe-mock fails to become ready", async () => {
      // Temporarily replace STRIPE_MOCK_PATH-referenced binary with a no-op script
      // that exits immediately, so the process starts but never listens on the port
      const testPort = 59998;
      const manager = new StripeMockManager(testPort);

      // Ensure nothing is running on that port
      const beforeRunning = await isStripeMockRunning(testPort);
      if (beforeRunning) return;

      // Create a fake binary that exits immediately without starting a server
      const fakeBinDir = await Deno.makeTempDir();
      const fakeBinPath = `${fakeBinDir}/stripe-mock`;
      await Deno.writeTextFile(fakeBinPath, "#!/bin/sh\nexit 0\n");
      await new Deno.Command("chmod", {
        args: ["+x", fakeBinPath],
        stderr: "null",
        stdout: "null",
      }).output();

      // Temporarily rename the real binary and put our fake one in its place
      const realPath = STRIPE_MOCK_PATH;
      const backupPath = `${realPath}.bak`;
      let renamed = false;

      try {
        await Deno.rename(realPath, backupPath);
        await Deno.copyFile(fakeBinPath, realPath);
        await new Deno.Command("chmod", {
          args: ["+x", realPath],
          stderr: "null",
          stdout: "null",
        }).output();
        renamed = true;

        await expect(manager.start(3, 10)).rejects.toThrow(
          "stripe-mock failed to start",
        );
      } finally {
        if (renamed) {
          await Deno.rename(backupPath, realPath);
        }
        await Deno.remove(fakeBinDir, { recursive: true });
        try {
          manager.stop();
        } catch {
          // Process may have already exited
        }
      }
    });
  });

  describe("downloadStripeMock with missing binary", () => {
    test("creates the bin dir, downloads an executable binary, and cleans up the tarball", async () => {
      // Move the whole bin dir aside so downloadStripeMock must recreate it
      // (the already-running stripe-mock keeps its open file handle).
      const backupDir = `${BIN_DIR}.bak-dl`;
      const tarPath = `${BIN_DIR}/stripe-mock.tar.gz`;
      let movedAway = false;

      try {
        await Deno.rename(BIN_DIR, backupDir);
        movedAway = true;

        // Bin dir is gone: download must mkdir it, fetch, extract, chmod, clean up.
        await downloadStripeMock();

        // Binary was downloaded as a real file...
        const stat = await Deno.stat(STRIPE_MOCK_PATH);
        expect(stat.isFile).toBe(true);
        // ...and made executable (owner execute bit set by chmod +x).
        expect((stat.mode ?? 0) & 0o100).toBe(0o100);
        // ...and the intermediate tarball was removed.
        await expect(Deno.stat(tarPath)).rejects.toThrow(Deno.errors.NotFound);
      } finally {
        // Discard the freshly downloaded dir and restore the original.
        if (movedAway) {
          try {
            await Deno.remove(BIN_DIR, { recursive: true });
          } catch {
            // May not exist if download failed
          }
          await Deno.rename(backupDir, BIN_DIR);
        }
      }
    });
  });

  describe("getPlatform", () => {
    test("returns a valid platform string", () => {
      const platform = getPlatform();
      expect(["darwin", "linux"].includes(platform)).toBe(true);
    });
  });

  describe("getArch", () => {
    test("returns a valid architecture string", () => {
      const arch = getArch();
      expect(["arm64", "amd64"].includes(arch)).toBe(true);
    });
  });
});
