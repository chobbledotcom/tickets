import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import type { ErrorPageFn } from "#routes/admin/settings-helpers.ts";
import {
  processSecretField,
  secretFieldHandler,
} from "#routes/admin/settings-helpers.ts";
import type { AuthSession } from "#routes/auth.ts";
import { MASK_SENTINEL } from "#shared/db/settings.ts";
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

describe("processSecretField", () => {
  test("returns 'unchanged' for the mask sentinel", () => {
    expect(processSecretField(formFrom({ key: MASK_SENTINEL }), "key")).toEqual(
      { action: "unchanged" },
    );
  });

  test("returns 'cleared' for empty string", () => {
    expect(processSecretField(formFrom({ key: "" }), "key")).toEqual({
      action: "cleared",
    });
  });

  test("returns 'cleared' for whitespace-only string", () => {
    // getString trims, so "   " becomes "" which is falsy → cleared
    expect(processSecretField(formFrom({ key: "   " }), "key")).toEqual({
      action: "cleared",
    });
  });

  test("returns 'cleared' when field is absent from form", () => {
    expect(processSecretField(formFrom({}), "key")).toEqual({
      action: "cleared",
    });
  });

  test("returns 'provided' with trimmed value for a non-empty non-sentinel string", () => {
    expect(
      processSecretField(formFrom({ key: "  sk_test_123  " }), "key"),
    ).toEqual({ action: "provided", value: "sk_test_123" });
  });
});

describeWithEnv("secretFieldHandler", { db: true }, () => {
  let mockErrorPage: ErrorPageFn & ReturnType<typeof fn>;

  beforeEach(() => {
    mockErrorPage = fn(
      (error: string, status: number, _formId: string) =>
        new Response(`error: ${error}`, { status }),
    ) as unknown as ErrorPageFn & ReturnType<typeof fn>;
  });

  test("redirects with 'unchanged' flash and skips save for sentinel value", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = secretFieldHandler({
      field: "api_key",
      formId: "settings-secret",
      label: "API key",
      save: saveFn as (v: string) => Promise<void>,
    });

    const res = await handler(
      formFrom({ api_key: MASK_SENTINEL }),
      mockErrorPage,
      nullSession,
    );

    expectRedirect(res, "/admin/settings");
    expect(saveFn).not.toHaveBeenCalled();
    expectFlash(res, "API key unchanged");
  });

  test("returns error when required field is cleared", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = secretFieldHandler({
      field: "api_key",
      formId: "settings-secret",
      label: "API key",
      required: true,
      save: saveFn as (v: string) => Promise<void>,
    });

    const res = await handler(
      formFrom({ api_key: "" }),
      mockErrorPage,
      nullSession,
    );

    expect(res.status).toBe(400);
    expect(saveFn).not.toHaveBeenCalled();
    expect(mockErrorPage).toHaveBeenCalledWith(
      "API key is required",
      400,
      "settings-secret",
    );
  });

  test("redirects with 'cleared' flash when optional field is cleared", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = secretFieldHandler({
      field: "api_key",
      formId: "settings-secret",
      label: "API key",
      required: false,
      save: saveFn as (v: string) => Promise<void>,
    });

    const res = await handler(
      formFrom({ api_key: "" }),
      mockErrorPage,
      nullSession,
    );

    expectRedirect(res, "/admin/settings");
    expect(saveFn).not.toHaveBeenCalled();
    expectFlash(res, "API key cleared");
  });

  test("saves, logs, and flashes 'updated successfully' for a new value", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = secretFieldHandler({
      field: "api_key",
      formId: "settings-secret",
      label: "API key",
      save: saveFn as (v: string) => Promise<void>,
    });

    const res = await handler(
      formFrom({ api_key: "new_secret_value" }),
      mockErrorPage,
      nullSession,
    );

    expectRedirect(res, "/admin/settings");
    expect(saveFn).toHaveBeenCalledWith("new_secret_value");
    expect(await lastLogMessage()).toBe("API key configured");
    expectFlash(res, "API key updated successfully");
  });

  test("calls errorPage and skips save when validation fails", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = secretFieldHandler({
      field: "api_key",
      formId: "settings-secret",
      label: "API key",
      save: saveFn as (v: string) => Promise<void>,
      validate: (v) =>
        !v.startsWith("sk_") ? "Key must start with sk_" : null,
    });

    const res = await handler(
      formFrom({ api_key: "bad_key" }),
      mockErrorPage,
      nullSession,
    );

    expect(res.status).toBe(400);
    expect(saveFn).not.toHaveBeenCalled();
    expect(mockErrorPage).toHaveBeenCalledWith(
      "Key must start with sk_",
      400,
      "settings-secret",
    );
  });

  test("calls afterSave with the new value after saving", async () => {
    const saveFn = fn(() => Promise.resolve());
    const afterSaveFn = fn(() => Promise.resolve());
    const handler = secretFieldHandler({
      afterSave: afterSaveFn as (v: string) => Promise<void>,
      field: "api_key",
      formId: "settings-secret",
      label: "API key",
      save: saveFn as (v: string) => Promise<void>,
    });

    await handler(
      formFrom({ api_key: "new_value" }),
      mockErrorPage,
      nullSession,
    );

    expect(saveFn).toHaveBeenCalledWith("new_value");
    expect(afterSaveFn).toHaveBeenCalledWith("new_value");
  });

  describe("advanced redirect", () => {
    test("redirects to /admin/settings-advanced when advanced is true (provided)", async () => {
      const handler = secretFieldHandler({
        advanced: true,
        field: "api_key",
        formId: "settings-secret",
        label: "API key",
        save: () => Promise.resolve(),
      });

      const res = await handler(
        formFrom({ api_key: "new_value" }),
        mockErrorPage,
        nullSession,
      );
      expectRedirect(res, "/admin/settings-advanced");
    });

    test("redirects to advanced page for 'unchanged' action when advanced is true", async () => {
      const handler = secretFieldHandler({
        advanced: true,
        field: "api_key",
        formId: "settings-secret",
        label: "API key",
        save: () => Promise.resolve(),
      });

      const res = await handler(
        formFrom({ api_key: MASK_SENTINEL }),
        mockErrorPage,
        nullSession,
      );
      expectRedirect(res, "/admin/settings-advanced");
    });

    test("redirects to advanced page for 'cleared' action when advanced is true", async () => {
      const handler = secretFieldHandler({
        advanced: true,
        field: "api_key",
        formId: "settings-secret",
        label: "API key",
        save: () => Promise.resolve(),
      });

      const res = await handler(
        formFrom({ api_key: "" }),
        mockErrorPage,
        nullSession,
      );
      expectRedirect(res, "/admin/settings-advanced");
    });
  });

  test("omits form= param from redirect when formId is not provided", async () => {
    const handler = secretFieldHandler({
      field: "api_key",
      label: "API key",
      save: () => Promise.resolve(),
    });

    const res = await handler(
      formFrom({ api_key: "new_value" }),
      mockErrorPage,
      nullSession,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").not.toContain("form=");
  });
});
