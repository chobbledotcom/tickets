import * as v from "valibot";
import { bearerAuthorization, bearerTokenOrNull } from "#shared/bearer.ts";

/**
 * Reading the effective Authorization header a Kuma monitor sends.
 *
 * Kuma stores custom headers as a JSON string and a separate built-in bearer
 * token (when `authMethod === "bearer"`). The runner only parses the stored
 * headers string when it is truthy, so an empty string means no custom
 * headers. A custom Authorization header overrides the built-in token.
 */

const CustomHeadersSchema = v.record(v.string(), v.string());

type CustomAuthorization = {
  authorization: string | null;
  valid: boolean;
};

export const readCustomAuthorization = (
  headers: string | null,
): CustomAuthorization => {
  if (headers === null || headers === "") {
    return { authorization: null, valid: true };
  }
  try {
    const values = v.parse(CustomHeadersSchema, JSON.parse(headers));
    const entry = Object.entries(values).find(
      ([name]) => name.toLowerCase() === "authorization",
    );
    return {
      authorization: entry === undefined ? null : entry[1],
      valid: true,
    };
  } catch {
    // A malformed custom header belongs to a different, broken monitor.
    return { authorization: null, valid: false };
  }
};

export const authorizationFor = (
  headers: string | null,
  authMethod: string | null,
  bearerToken: string | null,
): string | null => {
  const custom = readCustomAuthorization(headers);
  if (!custom.valid) return null;
  if (custom.authorization !== null) {
    const token = bearerTokenOrNull(custom.authorization);
    return token === null ? custom.authorization : bearerAuthorization(token);
  }
  return authMethod === "bearer" && bearerToken !== null
    ? bearerAuthorization(bearerToken)
    : null;
};
