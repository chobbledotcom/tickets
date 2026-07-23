import * as v from "valibot";
import { integerAtLeast } from "#shared/validation/number.ts";
import { parseOrThrow } from "#shared/validation/parse.ts";
import { authorizationFor } from "./authorization.ts";
import { UptimeKumaError } from "./error.ts";

/**
 * Valibot schemas for the Uptime Kuma monitor-list and response payloads.
 *
 * Kuma pushes monitors as a record keyed by string id, with snake_case
 * fields. The transform converts them to the camelCase
 * {@link UptimeKumaMonitor} shape, including the effective Authorization
 * header derived from the custom headers and built-in bearer token.
 */

export type UptimeKumaMonitorInput = Record<string, unknown>;

const ActiveSchema = v.pipe(
  v.union([v.boolean(), v.literal(0), v.literal(1)]),
  v.transform((value) => value === true || value === 1),
);

export interface UptimeKumaMonitor {
  acceptedStatusCodes: string[];
  active: boolean;
  authorization: string | null;
  conditions: unknown[];
  id: number;
  interval: number;
  method: string;
  name: string;
  parent: number | null;
  timeout: number;
  type: string;
  upsideDown: boolean;
  url: string | null;
}

const RawMonitorSchema = v.object({
  accepted_statuscodes: v.array(v.string()),
  active: ActiveSchema,
  authMethod: v.nullable(v.string()),
  bearer_token: v.nullable(v.string()),
  conditions: v.array(v.unknown()),
  headers: v.nullable(v.string()),
  id: integerAtLeast(1),
  interval: integerAtLeast(1),
  method: v.string(),
  name: v.string(),
  parent: v.nullable(integerAtLeast(1)),
  timeout: integerAtLeast(1),
  type: v.string(),
  upsideDown: ActiveSchema,
  url: v.nullable(v.string()),
});

const MonitorSchema = v.pipe(
  RawMonitorSchema,
  v.transform(
    ({
      accepted_statuscodes,
      authMethod,
      bearer_token,
      headers,
      ...monitor
    }) => ({
      ...monitor,
      acceptedStatusCodes: accepted_statuscodes,
      authorization: authorizationFor(headers, authMethod, bearer_token),
    }),
  ),
);

export const MonitorListSchema = v.record(v.string(), MonitorSchema);

const OkResponseSchema = v.object({ ok: v.literal(true) });
const FailedResponseSchema = v.object({
  msg: v.string(),
  ok: v.literal(false),
});
const BasicResponseSchema = v.union([OkResponseSchema, FailedResponseSchema]);

const PlainLoginFailureSchema = v.object({
  msg: v.string(),
  msgi18n: v.optional(v.literal(false)),
  ok: v.literal(false),
});
const IncorrectCredentialsSchema = v.object({
  msg: v.literal("authIncorrectCreds"),
  msgi18n: v.literal(true),
  ok: v.literal(false),
});

export const LoginResponseSchema = v.union([
  OkResponseSchema,
  IncorrectCredentialsSchema,
  PlainLoginFailureSchema,
  v.object({ tokenRequired: v.literal(true) }),
]);

export const AddResponseSchema = v.union([
  v.object({ monitorID: integerAtLeast(1), ok: v.literal(true) }),
  FailedResponseSchema,
]);

export const parseKumaResponse = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  value: unknown,
): v.InferOutput<TSchema> =>
  parseOrThrow(schema, value, () => new UptimeKumaError("invalid_response"));

export const requireOk = (value: unknown): void => {
  const response = parseKumaResponse(BasicResponseSchema, value);
  if (!response.ok) throw new Error(response.msg);
};
