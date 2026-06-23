import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import type { ErrorPageFn } from "#routes/admin/settings-helpers.ts";
import { createSettingsHandler } from "#routes/admin/settings-helpers.ts";
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

describeWithEnv("createSettingsHandler", { db: true }, () => {
  let mockErrorPage: ErrorPageFn & ReturnType<typeof fn>;

  beforeEach(() => {
    mockErrorPage = fn(
      (error: string, status: number, _formId: string) =>
        new Response(`error: ${error}`, { status }),
    ) as unknown as ErrorPageFn & ReturnType<typeof fn>;
  });

  test("redirects with flash on success", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = createSettingsHandler({
      extract: (form) => form.getString("value"),
      formId: "settings-test",
      label: "Test setting",
      save: saveFn as (v: string) => Promise<void>,
    });

    const res = await handler(
      formFrom({ value: "hello" }),
      mockErrorPage,
      nullSession,
    );

    expectRedirect(res, "/admin/settings", "form=settings-test");
    expectFlash(res, "Test setting updated");
    expect(saveFn).toHaveBeenCalledWith("hello");
    expect(await lastLogMessage()).toBe("Test setting updated");
  });

  test("uses custom log fn for activity log and flash message", async () => {
    const handler = createSettingsHandler({
      extract: (form) => form.getString("value"),
      formId: "settings-test",
      label: "Test",
      log: (v) => `Set to ${v}`,
      save: () => Promise.resolve(),
    });

    const res = await handler(
      formFrom({ value: "y" }),
      mockErrorPage,
      nullSession,
    );

    expect(await lastLogMessage()).toBe("Set to y");
    expectFlash(res, "Set to y");
  });

  test("calls errorPage and skips save when validation fails", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = createSettingsHandler({
      extract: (form) => form.getString("value"),
      formId: "settings-test",
      label: "Test",
      save: saveFn as (v: string) => Promise<void>,
      validate: (v) => (v === "" ? "Value is required" : null),
    });

    const res = await handler(
      formFrom({ value: "" }),
      mockErrorPage,
      nullSession,
    );

    expect(res.status).toBe(400);
    expect(saveFn).not.toHaveBeenCalled();
    expect(mockErrorPage).toHaveBeenCalledWith(
      "Value is required",
      400,
      "settings-test",
    );
  });

  test("async validator is awaited before save", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = createSettingsHandler({
      extract: (form) => form.getString("value"),
      formId: "settings-test",
      label: "Test",
      save: saveFn as (v: string) => Promise<void>,
      validate: (v) => Promise.resolve(v === "" ? "Async error" : null),
    });

    const res = await handler(
      formFrom({ value: "" }),
      mockErrorPage,
      nullSession,
    );

    expect(res.status).toBe(400);
    expect(saveFn).not.toHaveBeenCalled();
    expect(mockErrorPage).toHaveBeenCalledWith(
      "Async error",
      400,
      "settings-test",
    );
  });

  test("proceeds without calling errorPage when no validate function provided", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = createSettingsHandler({
      extract: (form) => form.getString("value"),
      formId: "settings-test",
      label: "Test",
      save: saveFn as (v: string) => Promise<void>,
    });

    const res = await handler(
      formFrom({ value: "" }),
      mockErrorPage,
      nullSession,
    );

    expect(res.status).toBe(302);
    expect(saveFn).toHaveBeenCalledWith("");
    expect(mockErrorPage).not.toHaveBeenCalled();
  });

  describe("redirect targets", () => {
    test("redirects to /admin/settings-advanced when advanced is true", async () => {
      const handler = createSettingsHandler({
        advanced: true,
        extract: (form) => form.getString("value"),
        formId: "settings-test",
        label: "Test",
        save: () => Promise.resolve(),
      });

      const res = await handler(
        formFrom({ value: "x" }),
        mockErrorPage,
        nullSession,
      );

      expectRedirect(res, "/admin/settings-advanced");
    });

    test("redirects to custom path when redirectTo is set", async () => {
      const handler = createSettingsHandler({
        extract: (form) => form.getString("value"),
        label: "Test",
        redirectTo: "/admin/site",
        save: () => Promise.resolve(),
      });

      const res = await handler(
        formFrom({ value: "x" }),
        mockErrorPage,
        nullSession,
      );

      expectRedirect(res, "/admin/site");
    });

    test("omits form= param from redirect when formId is not provided", async () => {
      const handler = createSettingsHandler({
        extract: (form) => form.getString("value"),
        label: "Test",
        redirectTo: "/admin/site",
        save: () => Promise.resolve(),
      });

      const res = await handler(
        formFrom({ value: "x" }),
        mockErrorPage,
        nullSession,
      );
      const location = res.headers.get("location") ?? "";

      expect(location).not.toContain("form=");
    });

    test("passes empty formId to errorPage when formId is not set", async () => {
      const handler = createSettingsHandler({
        extract: (form) => form.getString("value"),
        label: "Test",
        redirectTo: "/admin/site",
        save: () => Promise.resolve(),
        validate: () => "error",
      });

      await handler(formFrom({ value: "x" }), mockErrorPage, nullSession);

      expect(mockErrorPage).toHaveBeenCalledWith("error", 400, "");
    });
  });
});
