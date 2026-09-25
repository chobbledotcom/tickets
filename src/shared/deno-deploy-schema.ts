import * as v from "valibot";

export const DenoAppIdentitySchema = v.object({
  id: v.string(),
  slug: v.string(),
});

/** One env var entry shape: the secret flag decides whether the value is
 * optional (the API omits a secret's value) or required (a plain entry
 * without a value is a contract failure, not a message that silently reads
 * as unset). */
const envVarEntry = <
  SecretSchema extends v.GenericSchema,
  ValueSchema extends v.GenericSchema,
>(
  secret: SecretSchema,
  value: ValueSchema,
) => v.object({ key: v.string(), secret, value });

export const DenoAppEnvVarsSchema = v.object({
  env_vars: v.array(
    v.union([
      envVarEntry(v.literal(true), v.optional(v.string())),
      envVarEntry(v.literal(false), v.string()),
    ]),
  ),
});

export type DenoEnvVar = v.InferOutput<
  typeof DenoAppEnvVarsSchema
>["env_vars"][number];

export const DenoRevisionStatusSchema = v.picklist([
  "skipped",
  "queued",
  "building",
  "succeeded",
  "failed",
]);

export type DenoRevisionStatus = v.InferOutput<typeof DenoRevisionStatusSchema>;

export const DenoRevisionSchema = v.object({
  failure_reason: v.optional(
    v.nullable(v.picklist(["error", "cancelled", "timed_out", "skipped"])),
    null,
  ),
  id: v.string(),
  status: DenoRevisionStatusSchema,
});

export type DenoRevision = v.InferOutput<typeof DenoRevisionSchema>;
