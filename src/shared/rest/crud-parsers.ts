/**
 * JSON body parsing and validation helpers shared by the CRUD API factory and
 * per-resource API modules. Extracted from `crud-api.ts` so the factory stays
 * focused on route generation.
 */

import { isNotNullish, reduce } from "#fp";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { ADMIN_API, type AuthPolicy, withAuth } from "#routes/auth.ts";
import {
  errorResult,
  okResult,
  parseOptionalResult,
  type Result,
} from "#shared/result.ts";
import type { AdminSession } from "#shared/types.ts";

/** JSON body for confirmed delete endpoints */
export type DeleteBody = { confirm_identifier: string };

/**
 * Parse a required non-empty string field from a JSON body.
 * Returns the trimmed string or null if missing/empty.
 */
const requireString = (
  body: Record<string, unknown>,
  key: string,
): string | null =>
  typeof body[key] === "string" && body[key].trim() !== ""
    ? body[key].trim()
    : null;

/** Parse every item with one shared first-error traversal. */
const parseEach =
  <Input, Output>(parseItem: (item: Input) => Result<Output>) =>
  (items: readonly Input[]): Result<Output[]> =>
    reduce((result: Result<Output[]>, item: Input): Result<Output[]> => {
      if (!result.ok) return result;
      const parsed = parseItem(item);
      if (!parsed.ok) return parsed;
      result.value.push(parsed.value);
      return result;
    }, okResult<Output[]>([]))([...items]);

/**
 * Read several required non-empty string fields from a JSON body in one call.
 * Returns the trimmed values keyed by field name, or a ready `{ ok: false }`
 * rejection naming the first missing/empty field.
 */
export const requireStrings = <K extends string>(
  body: Record<string, unknown>,
  keys: readonly K[],
): Result<Record<K, string>> => {
  const parsed = parseEach((key: K): Result<readonly [K, string]> => {
    const value = requireString(body, key);
    return value
      ? okResult([key, value] as const)
      : errorResult(`${key} is required`);
  })(keys);
  return parsed.ok
    ? okResult(Object.fromEntries(parsed.value) as Record<K, string>)
    : parsed;
};

/**
 * Read an optional number from a JSON body, falling back to `fallback` when the
 * key is absent or holds the wrong type.
 */
export const bodyNumber = (
  body: Record<string, unknown>,
  key: string,
  fallback: number,
): number => (typeof body[key] === "number" ? body[key] : fallback);

/**
 * Parse an optional JSON-array field with partial-update semantics, failing
 * closed. `undefined` → ok with `undefined` (caller leaves existing data
 * untouched); a non-array → error; otherwise every element runs through
 * `parseItem` and the first rejection fails the whole parse.
 */
export const parseOptionalArray = <T>(
  raw: unknown,
  label: string,
  parseItem: (item: unknown) => Result<T>,
): Result<T[] | undefined> =>
  parseOptionalResult(raw, (value) => {
    if (!Array.isArray(value)) {
      return errorResult(`${label} must be an array`);
    }
    return parseEach(parseItem)(value);
  });

/** Result of parsing + validating: either the input or a pre-built error response */
export type ValidatedInput<Input> =
  | { ok: true; input: Input }
  | { ok: false; response: Response };

/**
 * Parse + validate a JSON body into a typed input, returning a ready-to-return
 * error response on failure.
 */
export const parseAndValidate = async <Input>(
  parsed: Result<Input> | Promise<Result<Input>>,
  validate?: (input: Input, id?: number) => Promise<string | null>,
  id?: number,
): Promise<ValidatedInput<Input>> => {
  const result = await parsed;
  if (!result.ok) {
    return { ok: false, response: apiErrorResponse(result.error) };
  }
  if (validate) {
    const error = await validate(result.value, id);
    if (error) return { ok: false, response: apiErrorResponse(error) };
  }
  return { input: result.value, ok: true };
};

/**
 * Parse an optional slug field from a JSON body for update operations.
 * Returns the normalized slug and computed index, falling back to the existing slug.
 */
export const parseUpdateSlug = async <Index extends string>(
  body: Record<string, unknown>,
  existing: string,
  normalize: (slug: string) => string,
  computeIndex: (slug: string) => Promise<Index>,
): Promise<{ slug: string; slugIndex: Index }> => {
  const slug = isNotNullish(body.slug)
    ? normalize(String(body.slug))
    : existing;
  return { slug, slugIndex: await computeIndex(slug) };
};

/**
 * Parse a name field from a JSON body for update operations.
 * Returns the trimmed name from the body (if provided), or falls back to the existing value.
 * Returns an error result if the resolved name is empty.
 */
export const parseUpdateName = (
  body: Record<string, unknown>,
  existing: string,
): Result<string> => {
  const name = isNotNullish(body.name) ? String(body.name).trim() : existing;
  return name === "" ? errorResult("name cannot be empty") : okResult(name);
};

/** Callback receiving an entity row plus auth context */
export type EntityHandler<Row> = (
  row: Row,
  session: AdminSession,
  body: Record<string, unknown>,
) => Promise<Response>;

/**
 * Auth + entity lookup helper.
 * Calls withAuth, fetches the entity by ID, and passes it to the callback.
 * Returns 404 automatically if the entity doesn't exist.
 */
export const withApiEntity = <Row>(
  request: Request,
  lookup: (id: number) => Promise<Row | null>,
  id: number,
  notFoundLabel: string,
  handler: EntityHandler<Row>,
  policy: AuthPolicy<"json"> = ADMIN_API,
): Promise<Response> =>
  withAuth(request, policy, async (session, body) => {
    const row = await lookup(id);
    if (!row) return apiErrorResponse(`${notFoundLabel} not found`, 404);
    return handler(row, session, body);
  });
