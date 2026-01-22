/**
 * Test utilities for the ticket reservation system
 */

import { createClient } from "@libsql/client";
import { completeSetup, initDb, setDb } from "../lib/db.ts";

/**
 * Default test admin password
 */
export const TEST_ADMIN_PASSWORD = "testpassword123";

/**
 * Create an in-memory database for testing
 */
export const createTestDb = async (): Promise<void> => {
  const client = createClient({ url: ":memory:" });
  setDb(client);
  await initDb();
};

/**
 * Create an in-memory database with setup already completed
 * This is the common case for most tests
 */
export const createTestDbWithSetup = async (
  stripeKey: string | null = null,
  currency = "GBP",
): Promise<void> => {
  await createTestDb();
  await completeSetup(TEST_ADMIN_PASSWORD, stripeKey, currency);
};

/**
 * Reset the database connection
 */
export const resetDb = (): void => {
  setDb(null);
};

/**
 * Create a mock Request object
 */
export const mockRequest = (
  path: string,
  options: RequestInit = {},
): Request => {
  return new Request(`http://localhost${path}`, options);
};

/**
 * Create a mock POST request with form data
 */
export const mockFormRequest = (
  path: string,
  data: Record<string, string>,
  cookie?: string,
): Request => {
  const body = new URLSearchParams(data).toString();
  const headers: HeadersInit = {
    "content-type": "application/x-www-form-urlencoded",
    origin: "http://localhost",
  };
  if (cookie) {
    headers.cookie = cookie;
  }
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body,
  });
};

/**
 * Create a mock cross-origin POST request with form data
 */
export const mockCrossOriginFormRequest = (
  path: string,
  data: Record<string, string>,
  origin = "http://evil.com",
): Request => {
  const body = new URLSearchParams(data).toString();
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
    },
    body,
  });
};

/**
 * Wait for a specified number of milliseconds
 */
export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generate a random string of specified length
 */
export const randomString = (length: number): string => {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};
