/**
 * Ntfy error notification module
 * Sends error pings to a configured ntfy URL
 * Only includes domain and error code - no personal or encrypted data
 */

import { defineApiClient } from "#shared/api-client.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { getEnv } from "#shared/env.ts";
import { ErrorCode, logErrorLocal } from "#shared/logger.ts";

/**
 * Send an error notification to the configured ntfy URL
 * Returns a promise so callers can await delivery if needed.
 * Delivery failures are logged locally (via logErrorLocal) but never throw.
 */
export const sendNtfyError = async (code: string): Promise<void> => {
  const ntfyUrl = getEnv("NTFY_URL");
  if (!ntfyUrl) return;

  const domain = getEffectiveDomain();
  // The URL is the whole endpoint, not a base plus a path. The client owns
  // the request headers and the fetch. The path is empty.
  const client = defineApiClient({
    baseUrl: ntfyUrl,
    headers: () => ({
      Tags: "warning",
      Title: `${domain} error`,
    }),
  });

  try {
    await client.raw("", {
      body: code,
      method: "POST",
    });
  } catch {
    logErrorLocal({ code: ErrorCode.CDN_REQUEST, detail: "ntfy send failed" });
  }
};
