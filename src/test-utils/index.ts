/**
 * Test utilities for the ticket reservation system
 */

import { createClient } from "@libsql/client";
import { initDb, setDb } from "../lib/db.ts";

/**
 * Create an in-memory database for testing
 */
export const createTestDb = async (): Promise<void> => {
  const client = createClient({ url: ":memory:" });
  setDb(client);
  await initDb();
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
