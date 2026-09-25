import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  DenoAppEnvVarsSchema,
  DenoAppIdentitySchema,
  DenoRevisionSchema,
  DenoRevisionStatusSchema,
} from "#shared/deno-deploy-schema.ts";

test("accepts every documented revision status", () => {
  expect(
    DenoRevisionStatusSchema.options.map((status) =>
      v.parse(DenoRevisionSchema, { id: "revision-1", status }),
    ),
  ).toEqual([
    { failure_reason: null, id: "revision-1", status: "skipped" },
    { failure_reason: null, id: "revision-1", status: "queued" },
    { failure_reason: null, id: "revision-1", status: "building" },
    { failure_reason: null, id: "revision-1", status: "succeeded" },
    { failure_reason: null, id: "revision-1", status: "failed" },
  ]);
});

test("accepts every documented revision failure reason", () => {
  expect(
    ["error", "cancelled", "timed_out", "skipped"].map((failure_reason) =>
      v.parse(DenoRevisionSchema, {
        failure_reason,
        id: "revision-1",
        status: "failed",
      }),
    ),
  ).toEqual([
    { failure_reason: "error", id: "revision-1", status: "failed" },
    { failure_reason: "cancelled", id: "revision-1", status: "failed" },
    { failure_reason: "timed_out", id: "revision-1", status: "failed" },
    { failure_reason: "skipped", id: "revision-1", status: "failed" },
  ]);
});

test("rejects unknown revision states and missing identities", () => {
  expect(() =>
    v.parse(DenoRevisionSchema, { id: "revision-1", status: "running" }),
  ).toThrow();
  expect(() => v.parse(DenoRevisionSchema, { status: "succeeded" })).toThrow();
  expect(() => v.parse(DenoAppIdentitySchema, { slug: "child" })).toThrow();
  expect(() => v.parse(DenoAppIdentitySchema, { id: "app-1" })).toThrow();
});

test("reads app environment variables with their secret flag", () => {
  expect(
    v.parse(DenoAppEnvVarsSchema, {
      env_vars: [{ key: "DB_URL", secret: true }],
    }),
  ).toEqual({ env_vars: [{ key: "DB_URL", secret: true }] });
  expect(() => v.parse(DenoAppEnvVarsSchema, {})).toThrow();
});

test("requires a plain entry's value and a secret's flag", () => {
  expect(
    v.parse(DenoAppEnvVarsSchema, {
      env_vars: [{ key: "SUPPORT_PAGE_TEXT", secret: false, value: "# Hi" }],
    }),
  ).toEqual({
    env_vars: [{ key: "SUPPORT_PAGE_TEXT", secret: false, value: "# Hi" }],
  });
  // The API omits a secret's value, so only a plain entry missing one is a
  // contract failure.
  expect(() =>
    v.parse(DenoAppEnvVarsSchema, {
      env_vars: [{ key: "SUPPORT_PAGE_TEXT", secret: false }],
    }),
  ).toThrow();
  expect(() =>
    v.parse(DenoAppEnvVarsSchema, {
      env_vars: [{ key: "ORIGIN" }],
    }),
  ).toThrow();
});
