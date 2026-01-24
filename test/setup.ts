/**
 * Test setup - orchestrates stripe-mock lifecycle
 * This file is intentionally minimal and excluded from coverage.
 * All testable logic is in stripe-mock.ts
 */

import { setupTestEncryptionKey } from "#test-utils";
import {
  STRIPE_MOCK_PORT,
  StripeMockManager,
} from "#test-utils/stripe-mock.ts";

const manager = new StripeMockManager();

// Configure encryption key for tests
setupTestEncryptionKey();

// Configure allowed domain for tests (security middleware)
Deno.env.set("ALLOWED_DOMAIN", "localhost");

// Configure stripe-mock env vars
Deno.env.set("STRIPE_MOCK_HOST", "localhost");
Deno.env.set("STRIPE_MOCK_PORT", String(STRIPE_MOCK_PORT));

// Start stripe-mock before tests
await manager.start();

// Register cleanup on process exit
globalThis.addEventListener("unload", () => manager.stop());
