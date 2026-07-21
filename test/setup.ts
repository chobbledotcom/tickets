/**
 * Test setup - orchestrates stripe-mock lifecycle
 * This file is intentionally minimal and excluded from coverage.
 * All testable logic is in stripe-mock.ts
 */

import {
  startStripeMock,
  stripeMockEnv,
  stripeMockPortFromEnv,
} from "#scripts/stripe-mock.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

const port = stripeMockPortFromEnv();

// Configure encryption key for tests
setupTestEncryptionKey();

// Configure stripe-mock env vars.
const mockEnv = stripeMockEnv(port);
Deno.env.set("STRIPE_MOCK_HOST", mockEnv.STRIPE_MOCK_HOST);
Deno.env.set("STRIPE_MOCK_PORT", mockEnv.STRIPE_MOCK_PORT);

// Start stripe-mock before tests
const stripeMock = await startStripeMock({ port });

// Register synchronous cleanup for raw `deno test --import ./test/setup.ts`.
globalThis.addEventListener("unload", () => stripeMock.stopNow());
