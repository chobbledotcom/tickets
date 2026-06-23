import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { beforeEach, it as test } from "@std/testing/bdd";
import type { ErrorPageFn } from "#routes/admin/settings-helpers.ts";
import { clearableFieldHandler } from "#routes/admin/settings-helpers.ts";
import type { AuthSession } from "#routes/auth.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  describeWithEnv,
  expectFlash,
  expectRedirect,
  getAllActivityLog,
} from "#test-utils";

const formFrom = (data: Record<string, string>): FormParams =>
  new FormParams(new URLSearchParams(data));

// deno-lint-ignore no-explicit-any
const nullSession = null as any as AuthSession;

const lastLogMessage = async (): Promise<string> => {
  const logs = await getAllActivityLog(10);
  return logs[0]?.message ?? "";
};

describeWithEnv("clearableFieldHandler", { db: true }, () => {
  let mockErrorPage: ErrorPageFn & ReturnType<typeof fn>;

  beforeEach(() => {
    mockErrorPage = fn(
      (error: string, status: number, _formId: string) =>
        new Response(`error: ${error}`, { status }),
    ) as unknown as ErrorPageFn & ReturnType<typeof fn>;
  });

  test("saves and logs 'updated' for a valid non-empty value", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = clearableFieldHandler({
      field: "email",
      formId: "settings-email",
      label: "Email",
      save: saveFn as (v: string) => Promise<void>,
      validate: (v) => (!v.includes("@") ? "Invalid email" : null),
    });

    const res = await handler(
      formFrom({ email: "user@test.com" }),
      mockErrorPage,
      nullSession,
    );

    expectRedirect(res, "/admin/settings");
    expect(saveFn).toHaveBeenCalledWith("user@test.com");
    expect(await lastLogMessage()).toBe("Email updated");
    expectFlash(res, "Email updated");
  });

  test("saves empty string and logs 'cleared' when value is empty", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = clearableFieldHandler({
      field: "email",
      formId: "settings-email",
      label: "Email",
      save: saveFn as (v: string) => Promise<void>,
      validate: (v) => (!v.includes("@") ? "Invalid email" : null),
    });

    const res = await handler(
      formFrom({ email: "" }),
      mockErrorPage,
      nullSession,
    );

    expectRedirect(res, "/admin/settings");
    expect(saveFn).toHaveBeenCalledWith("");
    expect(await lastLogMessage()).toBe("Email cleared");
    expectFlash(res, "Email cleared");
  });

  test("treats whitespace-only value as cleared", async () => {
    // getString trims, so "   " → "" → treated as cleared, not as a provided value
    const saveFn = fn(() => Promise.resolve());
    const handler = clearableFieldHandler({
      field: "email",
      formId: "settings-email",
      label: "Email",
      save: saveFn as (v: string) => Promise<void>,
    });

    const res = await handler(
      formFrom({ email: "   " }),
      mockErrorPage,
      nullSession,
    );

    expect(saveFn).toHaveBeenCalledWith("");
    expectFlash(res, "Email cleared");
  });

  test("calls errorPage when non-empty value fails validation", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = clearableFieldHandler({
      field: "email",
      formId: "settings-email",
      label: "Email",
      save: saveFn as (v: string) => Promise<void>,
      validate: (v) => (!v.includes("@") ? "Invalid email" : null),
    });

    const res = await handler(
      formFrom({ email: "not-an-email" }),
      mockErrorPage,
      nullSession,
    );

    expect(res.status).toBe(400);
    expect(saveFn).not.toHaveBeenCalled();
    expect(mockErrorPage).toHaveBeenCalledWith(
      "Invalid email",
      400,
      "settings-email",
    );
  });

  test("skips validator for empty value even when validate is provided", async () => {
    // Clearing always succeeds regardless of the validator
    const validateFn = fn(
      (_v: string) => "Should not be called",
    ) as unknown as ((value: string) => string | null) & ReturnType<typeof fn>;
    const handler = clearableFieldHandler({
      field: "email",
      formId: "settings-email",
      label: "Email",
      save: () => Promise.resolve(),
      validate: validateFn,
    });

    const res = await handler(
      formFrom({ email: "" }),
      mockErrorPage,
      nullSession,
    );

    expect(res.status).toBe(302);
    expect(validateFn).not.toHaveBeenCalled();
  });

  test("saves without validate function", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = clearableFieldHandler({
      field: "my_field",
      formId: "settings-field",
      label: "My field",
      save: saveFn as (v: string) => Promise<void>,
    });

    const res = await handler(
      formFrom({ my_field: "some value" }),
      mockErrorPage,
      nullSession,
    );

    expect(res.status).toBe(302);
    expect(saveFn).toHaveBeenCalledWith("some value");
  });

  test("redirects to /admin/settings-advanced when advanced is true", async () => {
    const handler = clearableFieldHandler({
      advanced: true,
      field: "my_field",
      label: "My field",
      save: () => Promise.resolve(),
    });

    const res = await handler(
      formFrom({ my_field: "val" }),
      mockErrorPage,
      nullSession,
    );

    expectRedirect(res, "/admin/settings-advanced");
  });
});
