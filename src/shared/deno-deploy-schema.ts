import * as v from "valibot";

export const DenoAppIdentitySchema = v.object({
  id: v.string(),
  slug: v.string(),
});

export const DenoAppEnvVarsSchema = v.object({
  env_vars: v.array(v.object({ key: v.string() })),
});

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
