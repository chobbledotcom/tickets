import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { beforeEach, it as test } from "@std/testing/bdd";
import type { ErrorPageFn } from "#routes/admin/settings-helpers.ts";
import { clearableFieldHandler } from "#routes/admin/settings-helpers.ts";
import { describeWithEnv, expectFlash, expectRedirect } from "#test-utils";
import {
  lastLogMessage,
  makeMockErrorPage,
  runHandler,
} from "#test-utils/settings-handlers.ts";

/** A clearableFieldHandler for the "email" field (email validator) + spy save. */
const makeClearable = (
  overrides: Partial<Parameters<typeof clearableFieldHandler>[0]> = {},
) => {
  const saveFn = fn(() => Promise.resolve());
  const handler = clearableFieldHandler({
    field: "email",
    formId: "settings-email",
    label: "Email",
    save: saveFn as (v: string) => Promise<void>,
    validate: (v) => (!v.includes("@") ? "Invalid email" : null),
    ...overrides,
  });
  return { handler, saveFn };
};

describeWithEnv("clearableFieldHandler", { db: true }, () => {
  let mockErrorPage: ErrorPageFn & ReturnType<typeof fn>;

  beforeEach(() => {
    mockErrorPage = makeMockErrorPage();
  });

  test("saves and logs 'updated' for a valid non-empty value", async () => {
    const { handler, saveFn } = makeClearable();
    const res = await runHandler(
      handler,
      { email: "user@test.com" },
      mockErrorPage,
    );

    expectRedirect(res, "/admin/settings");
    expect(saveFn).toHaveBeenCalledWith("user@test.com");
    expect(await lastLogMessage()).toBe("Email updated");
    expectFlash(res, "Email updated");
  });

  test("saves empty string and logs 'cleared' when value is empty", async () => {
    const { handler, saveFn } = makeClearable();
    const res = await runHandler(handler, { email: "" }, mockErrorPage);

    expectRedirect(res, "/admin/settings");
    expect(saveFn).toHaveBeenCalledWith("");
    expect(await lastLogMessage()).toBe("Email cleared");
    expectFlash(res, "Email cleared");
  });

  test("treats whitespace-only value as cleared", async () => {
    // getString trims, so "   " → "" → treated as cleared, not a provided value
    const { handler, saveFn } = makeClearable();
    const res = await runHandler(handler, { email: "   " }, mockErrorPage);

    expect(saveFn).toHaveBeenCalledWith("");
    expectFlash(res, "Email cleared");
  });

  test("calls errorPage when non-empty value fails validation", async () => {
    const { handler, saveFn } = makeClearable();
    const res = await runHandler(
      handler,
      { email: "not-an-email" },
      mockErrorPage,
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
    const { handler } = makeClearable({ validate: validateFn });
    const res = await runHandler(handler, { email: "" }, mockErrorPage);

    expect(res.status).toBe(302);
    expect(validateFn).not.toHaveBeenCalled();
  });

  test("saves without validate function", async () => {
    const { handler, saveFn } = makeClearable({
      field: "my_field",
      formId: "settings-field",
      label: "My field",
      validate: undefined,
    });
    const res = await runHandler(
      handler,
      { my_field: "some value" },
      mockErrorPage,
    );

    expect(res.status).toBe(302);
    expect(saveFn).toHaveBeenCalledWith("some value");
  });

  test("redirects to /admin/settings-advanced when advanced is true", async () => {
    const { handler } = makeClearable({
      advanced: true,
      field: "my_field",
      formId: undefined,
      label: "My field",
      validate: undefined,
    });
    const res = await runHandler(handler, { my_field: "val" }, mockErrorPage);
    expectRedirect(res, "/admin/settings-advanced");
  });
});
