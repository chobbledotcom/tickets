/**
 * Test setup - manages stripe-mock lifecycle for integration tests
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";

const STRIPE_MOCK_VERSION = "0.188.0";
const STRIPE_MOCK_PORT = 12111;
const BIN_DIR = join(import.meta.dir, "..", ".bin");
const STRIPE_MOCK_PATH = join(BIN_DIR, "stripe-mock");

let stripeMockProcess: Subprocess | null = null;

/**
 * Download stripe-mock binary if not present
 */
const downloadStripeMock = async (): Promise<void> => {
  if (existsSync(STRIPE_MOCK_PATH)) return;

  mkdirSync(BIN_DIR, { recursive: true });

  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const ext = platform === "darwin" ? "tar.gz" : "tar.gz";

  const url = `https://github.com/stripe/stripe-mock/releases/download/v${STRIPE_MOCK_VERSION}/stripe-mock_${STRIPE_MOCK_VERSION}_${platform}_${arch}.${ext}`;

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
  await Bun.write(tarPath, "").then(() =>
    spawn(["rm", tarPath], { stdout: "ignore", stderr: "ignore" }),
  );
};

/**
 * Check if stripe-mock is already running on the port
 * Note: stripe-mock returns 401 for unauthenticated requests, which is still "running"
 */
const isStripeMockRunning = async (): Promise<boolean> => {
  try {
    await fetch(`http://localhost:${STRIPE_MOCK_PORT}/`);
    // Any response (including 401) means the server is running
    return true;
  } catch {
    return false;
  }
};

/**
 * Wait for stripe-mock to be ready
 */
const waitForStripeMock = async (maxAttempts = 30): Promise<boolean> => {
  for (let i = 0; i < maxAttempts; i++) {
    if (await isStripeMockRunning()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

/**
 * Start stripe-mock server
 */
const startStripeMock = async (): Promise<void> => {
  // Check if already running (e.g., in dev mode)
  if (await isStripeMockRunning()) {
    return;
  }

  // Download if needed
  await downloadStripeMock();

  // Start stripe-mock
  stripeMockProcess = spawn(
    [STRIPE_MOCK_PATH, "-port", String(STRIPE_MOCK_PORT)],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  // Wait for it to be ready
  const ready = await waitForStripeMock();
  if (!ready) {
    throw new Error("stripe-mock failed to start");
  }
};

/**
 * Stop stripe-mock server
 */
const stopStripeMock = (): void => {
  if (stripeMockProcess) {
    stripeMockProcess.kill();
    stripeMockProcess = null;
  }
};

// Configure stripe-mock env vars
process.env.STRIPE_MOCK_HOST = "localhost";
process.env.STRIPE_MOCK_PORT = String(STRIPE_MOCK_PORT);

// Start stripe-mock before tests
await startStripeMock();

// Register cleanup on process exit
process.on("exit", stopStripeMock);
process.on("SIGINT", () => {
  stopStripeMock();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopStripeMock();
  process.exit(0);
});
