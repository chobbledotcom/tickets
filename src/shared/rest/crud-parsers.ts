/** JSON body parsing and validation helpers for CRUD API modules. */

import { isNotNullish, reduce } from "#fp";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { type AuthPolicy, withAuth } from "#routes/auth.ts";
import {
  errorResult,
  okResult,
  parseOptionalResult,
  type Result,
} from "#shared/result.ts";
import {
  type DateString,
  parseDateString,
  parseDateStringOrThrow,
} from "#shared/validation/date.ts";
import type { AdminSession } from "#types";

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

/** Parse one cleaned-or-refused date value, naming the field. */
const dateStringResult = (key: string, raw: string): Result<DateString> => {
  const parsed = parseDateString(raw);
  return parsed === null
    ? errorResult(`${key} has an invalid value`)
    : okResult(parsed);
};

/**
 * Read one required real-calendar-date field from a JSON body. The value is
 * trimmed and validated at this boundary, so the mapped input carries a
 * `DateString` no comparison can mis-order. Absent or empty answers the
 * same rejection shape as {@link requireStrings}.
 */
/** Read one supplied date value from the body and hand it to the reader's
 *  outcomes. The value is text, the key is absent, or the value is not text.
 *  A non-text value is malformed, not absent. */
const withSuppliedDateValue = (
  body: Record<string, unknown>,
  key: string,
  onValue: (value: string) => Result<DateString>,
  onAbsent: () => Result<DateString>,
): Result<DateString> => {
  const raw = body[key];
  if (raw === undefined) return onAbsent();
  if (typeof raw !== "string") {
    return errorResult(`${key} has an invalid value`);
  }
  return onValue(raw);
};

/** The required date's outcomes: a blank or absent key answers required, a
 *  present text value parses. */
const requiredDate =
  (key: string) =>
  (value: string): Result<DateString> =>
    value.trim() === ""
      ? errorResult(`${key} is required`)
      : dateStringResult(key, value);

export const requireDateString = (
  body: Record<string, unknown>,
  key: string,
): Result<DateString> =>
  withSuppliedDateValue(body, key, requiredDate(key), () =>
    errorResult(`${key} is required`),
  );

/** Read the required name for one entity write. A supplied name must be a
 *  string: anything else is refused with the field-named message instead of
 *  coerced into stored text. An update without a supplied name keeps the
 *  stored one, and the resolved name must be non-empty. */
export const requireEntityName = (
  body: Record<string, unknown>,
  existing: string | null,
): Result<string> => {
  if (body.name !== undefined && typeof body.name !== "string") {
    return errorResult("name must be a string");
  }
  if (existing !== null) return parseUpdateName(body, existing);
  const name = requireStrings(body, ["name"]);
  return name.ok ? okResult(name.value.name) : name;
};

/** Combine the two date results of one range in field order: the start date
 *  reports first, then the end date. */
export const dateRange = (
  startDate: Result<DateString>,
  endDate: Result<DateString>,
): Result<{ endDate: DateString; startDate: DateString }> => {
  if (!startDate.ok) return startDate;
  if (!endDate.ok) return endDate;
  return okResult({ endDate: endDate.value, startDate: startDate.value });
};

/**
 * Read one optional real-calendar-date field from a JSON body. An absent key
 * keeps the fallback. A present-but-unusable value is refused with the
 * field-named message. The fallback is a stored date, so it parses through
 * the same rule before it travels as branded. A stored value the rule
 * refuses is an impossible state and stops the request loudly.
 */
export const optionalDateString = (
  body: Record<string, unknown>,
  key: string,
  fallback: string,
): Result<DateString> =>
  withSuppliedDateValue(
    body,
    key,
    (value) => dateStringResult(key, value),
    () => okResult(parseDateStringOrThrow(fallback, `${key} fallback`)),
  );

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
 * Parse a name field from a JSON body for update operations. A supplied name
 * must be a string: anything else is refused with the field-named message.
 * An absent name keeps the stored one, and the resolved name — stored or
 * supplied — must be non-empty.
 */
export const parseUpdateName = (
  body: Record<string, unknown>,
  existing: string,
): Result<string> => {
  if (body.name !== undefined && typeof body.name !== "string") {
    return errorResult("name must be a string");
  }
  const name = body.name === undefined ? existing : body.name.trim();
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
 * Returns 404 automatically if the entity doesn't exist. The policy is
 * required: every route declares the audience its matching admin page grants,
 * so no extra route can fall back to an undeclared one.
 */
export const withApiEntity = <Row>(
  request: Request,
  lookup: (id: number) => Promise<Row | null>,
  id: number,
  notFoundLabel: string,
  handler: EntityHandler<Row>,
  policy: AuthPolicy<"json">,
): Promise<Response> =>
  withAuth(request, policy, async (session, body) => {
    const row = await lookup(id);
    if (!row) return apiErrorResponse(`${notFoundLabel} not found`, 404);
    return handler(row, session, body);
  });

/** A JSON API handler that needs no session: the loaded row and the raw body. */
export type RowBodyHandler<Row> = (
  row: Row,
  body: Record<string, unknown>,
) => Promise<Response>;

/** Lifts a no-session handler into the withApiEntity handler shape. */
const withSession =
  <Row>(handler: RowBodyHandler<Row>): EntityHandler<Row> =>
  (row, _session, body) =>
    handler(row, body);

/**
 * One entity's JSON API gate: the loader, its not-found label, and the auth
 * policy, bound once. Every route for the entity then loads and guards the
 * same way. The policy is required: each caller declares the audience its
 * matching admin page grants.
 */
export const apiEntityGate =
  <Row>(
    lookup: (id: number) => Promise<Row | null>,
    notFoundLabel: string,
    policy: AuthPolicy<"json">,
  ) =>
  (
    request: Request,
    id: number,
    handler: RowBodyHandler<Row>,
  ): Promise<Response> =>
    withApiEntity(
      request,
      lookup,
      id,
      notFoundLabel,
      withSession(handler),
      policy,
    );
