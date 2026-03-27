import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { FormParams } from "#lib/form-data.ts";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { MASK_SENTINEL } from "#lib/db/settings.ts";
import {
  clearableFieldHandler,
  createSettingsHandler,
  processSecretField,
  secretFieldHandler,
  toggleHandler,
} from "#routes/admin/settings-helpers.ts";
import { describeWithEnv } from "#test-utils";

/** Build a FormParams from a plain object */
const formFrom = (data: Record<string, string>): FormParams =>
  new FormParams(new URLSearchParams(data));

/** Stub errorPage that captures its call */
const mockErrorPage = fn(
  (error: string, status: number, _formId: string) =>
    new Response(`error: ${error}`, { status }),
);

/** Extract redirect location from a 302 response */
const redirectLocation = (res: Response): string =>
  res.headers.get("location") ?? "";

/** Extract flash cookie value from response */
const getFlashMessage = (res: Response): string => {
  const cookies = res.headers.getSetCookie();
  const flash = cookies.find((c) => c.startsWith("flash_"));
  if (!flash) return "";
  const cookiePart = flash.split(";")[0] ?? "";
  return decodeURIComponent(cookiePart.split("=").slice(1).join("="));
};

/** Get the most recent activity log message */
const lastLogMessage = async (): Promise<string> => {
  const logs = await getAllActivityLog(10);
  return logs[0]?.message ?? "";
};

describeWithEnv("settings-helpers", { db: true }, () => {
  describe("createSettingsHandler", () => {
    test("runs extract → validate → save → log → redirect on success", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = createSettingsHandler({
        formId: "settings-test",
        label: "Test setting",
        extract: (form) => form.getString("value"),
        validate: (v) => (v === "" ? "Value is required" : null),
        save: saveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ value: "hello" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(302);
      expect(redirectLocation(res)).toContain("/admin/settings");
      expect(redirectLocation(res)).toContain("form=settings-test");
      expect(saveFn).toHaveBeenCalledWith("hello");
      expect(await lastLogMessage()).toBe("Test setting updated");
      expect(getFlashMessage(res)).toContain("Test setting updated");
    });

    test("uses custom log and message when provided", async () => {
      const handler = createSettingsHandler({
        formId: "settings-test",
        label: "Test",
        extract: (form) => form.getString("value"),
        save: () => Promise.resolve(),
        log: (v) => `Custom log: ${v}`,
        message: (v) => `Custom msg: ${v}`,
      });

      const form = formFrom({ value: "x" });
      const res = await handler(form, mockErrorPage, null);

      expect(await lastLogMessage()).toBe("Custom log: x");
      expect(getFlashMessage(res)).toContain("Custom msg: x");
    });

    test("message defaults to log output when only log is provided", async () => {
      const handler = createSettingsHandler({
        formId: "settings-test",
        label: "Test",
        extract: (form) => form.getString("value"),
        save: () => Promise.resolve(),
        log: (v) => `Set to ${v}`,
      });

      const form = formFrom({ value: "y" });
      const res = await handler(form, mockErrorPage, null);

      expect(await lastLogMessage()).toBe("Set to y");
      expect(getFlashMessage(res)).toContain("Set to y");
    });

    test("returns error when validation fails", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = createSettingsHandler({
        formId: "settings-test",
        label: "Test",
        extract: (form) => form.getString("value"),
        validate: (v) => (v === "" ? "Value is required" : null),
        save: saveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ value: "" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(400);
      expect(saveFn).not.toHaveBeenCalled();
      expect(mockErrorPage).toHaveBeenCalledWith(
        "Value is required",
        400,
        "settings-test",
      );
    });

    test("skips validation when no validate function provided", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = createSettingsHandler({
        formId: "settings-test",
        label: "Test",
        extract: (form) => form.getString("value"),
        save: saveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ value: "" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(302);
      expect(saveFn).toHaveBeenCalledWith("");
    });

    test("redirects to advanced page when advanced is true", async () => {
      const handler = createSettingsHandler({
        formId: "settings-test",
        label: "Test",
        advanced: true,
        extract: (form) => form.getString("value"),
        save: () => Promise.resolve(),
      });

      const form = formFrom({ value: "x" });
      const res = await handler(form, mockErrorPage, null);

      expect(redirectLocation(res)).toContain("/admin/settings-advanced");
    });
  });

  describe("toggleHandler", () => {
    test("saves true when field is 'true'", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = toggleHandler({
        formId: "settings-toggle",
        field: "my_toggle",
        label: "My feature",
        save: saveFn as (v: boolean) => Promise<void>,
      });

      const form = formFrom({ my_toggle: "true" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(302);
      expect(saveFn).toHaveBeenCalledWith(true);
      expect(await lastLogMessage()).toBe("My feature enabled");
      expect(getFlashMessage(res)).toContain("My feature enabled");
    });

    test("saves false when field is not 'true'", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = toggleHandler({
        formId: "settings-toggle",
        field: "my_toggle",
        label: "My feature",
        save: saveFn as (v: boolean) => Promise<void>,
      });

      const form = formFrom({ my_toggle: "false" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(302);
      expect(saveFn).toHaveBeenCalledWith(false);
      expect(await lastLogMessage()).toBe("My feature disabled");
      expect(getFlashMessage(res)).toContain("My feature disabled");
    });

    test("redirects to advanced page when advanced is true", async () => {
      const handler = toggleHandler({
        formId: "settings-toggle",
        field: "my_toggle",
        label: "My feature",
        advanced: true,
        save: () => Promise.resolve(),
      });

      const form = formFrom({ my_toggle: "true" });
      const res = await handler(form, mockErrorPage, null);

      expect(redirectLocation(res)).toContain("/admin/settings-advanced");
    });
  });

  describe("clearableFieldHandler", () => {
    test("saves non-empty value after validation passes", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = clearableFieldHandler({
        formId: "settings-email",
        field: "email",
        label: "Email",
        validate: (v) => (!v.includes("@") ? "Invalid email" : null),
        save: saveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ email: "user@test.com" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(302);
      expect(saveFn).toHaveBeenCalledWith("user@test.com");
      expect(await lastLogMessage()).toBe("Email updated");
      expect(getFlashMessage(res)).toContain("Email updated");
    });

    test("clears value when empty string submitted", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = clearableFieldHandler({
        formId: "settings-email",
        field: "email",
        label: "Email",
        validate: (v) => (!v.includes("@") ? "Invalid email" : null),
        save: saveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ email: "" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(302);
      expect(saveFn).toHaveBeenCalledWith("");
      expect(await lastLogMessage()).toBe("Email cleared");
      expect(getFlashMessage(res)).toContain("Email cleared");
    });

    test("returns error when non-empty value fails validation", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = clearableFieldHandler({
        formId: "settings-email",
        field: "email",
        label: "Email",
        validate: (v) => (!v.includes("@") ? "Invalid email" : null),
        save: saveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ email: "not-an-email" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(400);
      expect(saveFn).not.toHaveBeenCalled();
      expect(mockErrorPage).toHaveBeenCalledWith(
        "Invalid email",
        400,
        "settings-email",
      );
    });

    test("skips validation for empty value even with validator", async () => {
      const validateFn = fn((_v: string) => "Should not be called");
      const handler = clearableFieldHandler({
        formId: "settings-email",
        field: "email",
        label: "Email",
        validate: validateFn,
        save: () => Promise.resolve(),
      });

      const form = formFrom({ email: "" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(302);
      expect(validateFn).not.toHaveBeenCalled();
    });

    test("works without validate function", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = clearableFieldHandler({
        formId: "settings-field",
        field: "my_field",
        label: "My field",
        save: saveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ my_field: "some value" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(302);
      expect(saveFn).toHaveBeenCalledWith("some value");
    });
  });

  describe("processSecretField", () => {
    test("returns 'unchanged' for mask sentinel", () => {
      const form = formFrom({ key: MASK_SENTINEL });
      const result = processSecretField(form, "key");
      expect(result).toEqual({ action: "unchanged" });
    });

    test("returns 'cleared' for empty string", () => {
      const form = formFrom({ key: "" });
      const result = processSecretField(form, "key");
      expect(result).toEqual({ action: "cleared" });
    });

    test("returns 'provided' with value for non-empty non-sentinel", () => {
      const form = formFrom({ key: "sk_test_123" });
      const result = processSecretField(form, "key");
      expect(result).toEqual({ action: "provided", value: "sk_test_123" });
    });

    test("returns 'cleared' for missing field", () => {
      const form = formFrom({});
      const result = processSecretField(form, "key");
      expect(result).toEqual({ action: "cleared" });
    });
  });

  describe("secretFieldHandler", () => {
    test("redirects with 'unchanged' message for sentinel value", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = secretFieldHandler({
        formId: "settings-secret",
        field: "api_key",
        label: "API key",
        save: saveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ api_key: MASK_SENTINEL });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(302);
      expect(saveFn).not.toHaveBeenCalled();
      expect(getFlashMessage(res)).toContain("API key unchanged");
    });

    test("returns error when required field is cleared", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = secretFieldHandler({
        formId: "settings-secret",
        field: "api_key",
        label: "API key",
        required: true,
        save: saveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ api_key: "" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(400);
      expect(saveFn).not.toHaveBeenCalled();
      expect(mockErrorPage).toHaveBeenCalledWith(
        "API key is required",
        400,
        "settings-secret",
      );
    });

    test("redirects with 'cleared' message for optional field cleared", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = secretFieldHandler({
        formId: "settings-secret",
        field: "api_key",
        label: "API key",
        required: false,
        save: saveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ api_key: "" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(302);
      expect(saveFn).not.toHaveBeenCalled();
      expect(getFlashMessage(res)).toContain("API key cleared");
    });

    test("saves and logs when new value provided", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = secretFieldHandler({
        formId: "settings-secret",
        field: "api_key",
        label: "API key",
        save: saveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ api_key: "new_secret_value" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(302);
      expect(saveFn).toHaveBeenCalledWith("new_secret_value");
      expect(await lastLogMessage()).toBe("API key configured");
      expect(getFlashMessage(res)).toContain("API key updated successfully");
    });

    test("returns error when validation fails for provided value", async () => {
      const saveFn = fn(() => Promise.resolve());
      const handler = secretFieldHandler({
        formId: "settings-secret",
        field: "api_key",
        label: "API key",
        validate: (v) =>
          !v.startsWith("sk_") ? "Key must start with sk_" : null,
        save: saveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ api_key: "bad_key" });
      const res = await handler(form, mockErrorPage, null);

      expect(res.status).toBe(400);
      expect(saveFn).not.toHaveBeenCalled();
      expect(mockErrorPage).toHaveBeenCalledWith(
        "Key must start with sk_",
        400,
        "settings-secret",
      );
    });

    test("calls afterSave when provided", async () => {
      const saveFn = fn(() => Promise.resolve());
      const afterSaveFn = fn(() => Promise.resolve());
      const handler = secretFieldHandler({
        formId: "settings-secret",
        field: "api_key",
        label: "API key",
        save: saveFn as (v: string) => Promise<void>,
        afterSave: afterSaveFn as (v: string) => Promise<void>,
      });

      const form = formFrom({ api_key: "new_value" });
      await handler(form, mockErrorPage, null);

      expect(saveFn).toHaveBeenCalledWith("new_value");
      expect(afterSaveFn).toHaveBeenCalledWith("new_value");
    });

    test("redirects to advanced page when advanced is true", async () => {
      const handler = secretFieldHandler({
        formId: "settings-secret",
        field: "api_key",
        label: "API key",
        advanced: true,
        save: () => Promise.resolve(),
      });

      const form = formFrom({ api_key: "new_value" });
      const res = await handler(form, mockErrorPage, null);

      expect(redirectLocation(res)).toContain("/admin/settings-advanced");
    });

    test("advanced flag applies to unchanged action", async () => {
      const handler = secretFieldHandler({
        formId: "settings-secret",
        field: "api_key",
        label: "API key",
        advanced: true,
        save: () => Promise.resolve(),
      });

      const form = formFrom({ api_key: MASK_SENTINEL });
      const res = await handler(form, mockErrorPage, null);

      expect(redirectLocation(res)).toContain("/admin/settings-advanced");
    });

    test("advanced flag applies to cleared optional field", async () => {
      const handler = secretFieldHandler({
        formId: "settings-secret",
        field: "api_key",
        label: "API key",
        advanced: true,
        save: () => Promise.resolve(),
      });

      const form = formFrom({ api_key: "" });
      const res = await handler(form, mockErrorPage, null);

      expect(redirectLocation(res)).toContain("/admin/settings-advanced");
    });
  });
});
