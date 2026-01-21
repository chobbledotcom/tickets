/**
 * stripe-mock utilities for integration tests
 * Extracted from setup.ts to enable proper testing
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";

export const STRIPE_MOCK_VERSION = "0.188.0";
export const STRIPE_MOCK_PORT = 12111;
// Go up from src/test-utils to project root
export const BIN_DIR = join(import.meta.dir, "..", "..", ".bin");
export const STRIPE_MOCK_PATH = join(BIN_DIR, "stripe-mock");

/**
 * Download stripe-mock binary if not present
 */
export const downloadStripeMock = async (): Promise<void> => {
  if (existsSync(STRIPE_MOCK_PATH)) return;

  mkdirSync(BIN_DIR, { recursive: true });

  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";

  const url = `https://github.com/stripe/stripe-mock/releases/download/v${STRIPE_MOCK_VERSION}/stripe-mock_${STRIPE_MOCK_VERSION}_${platform}_${arch}.tar.gz`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download stripe-mock: ${response.status}`);
  }

  const tarPath = join(BIN_DIR, "stripe-mock.tar.gz");
  await Bun.write(tarPath, response);

  // Extract the binary
  const extract = spawn(["tar", "-xzf", tarPath, "-C", BIN_DIR], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await extract.exited;

  // Make executable
  const chmod = spawn(["chmod", "+x", STRIPE_MOCK_PATH], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await chmod.exited;

  // Clean up tar file
  const rm = spawn(["rm", tarPath], { stdout: "ignore", stderr: "ignore" });
  await rm.exited;
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
  private process: Subprocess | null = null;
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
    this.process = spawn([STRIPE_MOCK_PATH, "-port", String(this.port)], {
      stdout: "ignore",
      stderr: "ignore",
    });

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
