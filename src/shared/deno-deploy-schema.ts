import * as v from "valibot";

export const DenoAppIdentitySchema = v.object({
  id: v.string(),
  slug: v.string(),
});

export const DenoAppEnvVarsSchema = v.object({
  env_vars: v.array(
    v.object({
      id: v.optional(v.string()),
      key: v.string(),
      /** Omitted when the entry is a secret. */
      secret: v.optional(v.boolean(), false),
      value: v.optional(v.string()),
    }),
  ),
});

/** One app-level environment variable as the Deno Deploy API reports it. */
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
