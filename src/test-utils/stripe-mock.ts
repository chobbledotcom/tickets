/**
 * stripe-mock utilities for integration tests
 * Extracted from setup.ts to enable proper testing
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "@std/assert";

export const STRIPE_MOCK_VERSION = "0.188.0";
export const STRIPE_MOCK_PORT = 12111;
// Go up from src/test-utils to project root
const currentDir = dirname(fileURLToPath(import.meta.url));
export const BIN_DIR = join(currentDir, "..", "..", ".bin");
export const STRIPE_MOCK_PATH = join(BIN_DIR, "stripe-mock");

/** Platform and architecture maps for download URL */
const platformMap: Record<string, string> = { darwin: "darwin" };
const archMap: Record<string, string> = { aarch64: "arm64" };

/** Get platform identifier for stripe-mock download URL */
export const getPlatform = (): string => platformMap[Deno.build.os] ?? "linux";

/** Get architecture identifier for stripe-mock download URL */
export const getArch = (): string => archMap[Deno.build.arch] ?? "amd64";

/**
 * Download stripe-mock binary if not present
 * Uses curl instead of fetch to avoid Deno TLS certificate issues
 */
export const downloadStripeMock = async (): Promise<void> => {
  try {
    await Deno.stat(STRIPE_MOCK_PATH);
    return; // File exists
  } catch {
    // File doesn't exist, continue to download
  }

  await Deno.mkdir(BIN_DIR, { recursive: true });

  const platform = getPlatform();
  const arch = getArch();

  const url = `https://github.com/stripe/stripe-mock/releases/download/v${STRIPE_MOCK_VERSION}/stripe-mock_${STRIPE_MOCK_VERSION}_${platform}_${arch}.tar.gz`;

  // Use curl to download - avoids Deno TLS certificate issues
  const curlCmd = new Deno.Command("curl", {
    args: ["-sL", url, "-o", "-"],
    stdout: "piped",
    stderr: "null",
  });
  const curlResult = await curlCmd.output();
  assert(curlResult.success, "Failed to download stripe-mock with curl");

  const tarPath = join(BIN_DIR, "stripe-mock.tar.gz");
  await Deno.writeFile(tarPath, curlResult.stdout);

  // Extract the binary
  const extract = new Deno.Command("tar", {
    args: ["-xzf", tarPath, "-C", BIN_DIR],
    stdout: "null",
    stderr: "null",
  });
  await extract.output();

  // Make executable
  const chmod = new Deno.Command("chmod", {
    args: ["+x", STRIPE_MOCK_PATH],
    stdout: "null",
    stderr: "null",
  });
  await chmod.output();

  // Clean up tar file
  await Deno.remove(tarPath);
};

/**
 * Check if stripe-mock is already running on the port
 * Note: stripe-mock returns 401 for unauthenticated requests, which is still "running"
 */
export const isStripeMockRunning = async (
  port: number = STRIPE_MOCK_PORT,
): Promise<boolean> => {
  try {
    await fetch(`http://localhost:${port}/`);
    // Any response (including 401) means the server is running
    return true;
  } catch {
    return false;
  }
};

/**
 * Wait for stripe-mock to be ready
 */
export const waitForStripeMock = async (
  port: number = STRIPE_MOCK_PORT,
  maxAttempts = 30,
  delayMs = 100,
): Promise<boolean> => {
  for (let i = 0; i < maxAttempts; i++) {
    if (await isStripeMockRunning(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
};

/**
 * Manages stripe-mock process lifecycle
 */
export class StripeMockManager {
  private process: Deno.ChildProcess | null = null;
  private port: number;

  constructor(port: number = STRIPE_MOCK_PORT) {
    this.port = port;
  }

  /**
   * Start stripe-mock server
   */
  async start(): Promise<void> {
    // Check if already running (e.g., in dev mode)
    if (await isStripeMockRunning(this.port)) {
      return;
    }

    // Download if needed
    await downloadStripeMock();

    // Start stripe-mock
    const command = new Deno.Command(STRIPE_MOCK_PATH, {
      args: ["-port", String(this.port)],
      stdout: "null",
      stderr: "null",
    });
    this.process = command.spawn();

    // Wait for it to be ready
    const ready = await waitForStripeMock(this.port);
    if (!ready) {
      throw new Error("stripe-mock failed to start");
    }
  }

  /**
   * Stop stripe-mock server
   */
  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  /**
   * Check if this manager started the process
   */
  isManaged(): boolean {
    return this.process !== null;
  }
}
