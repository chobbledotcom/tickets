import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import type { ErrorPageFn } from "#routes/admin/settings-helpers.ts";
import {
  processSecretField,
  secretFieldHandler,
} from "#routes/admin/settings-helpers.ts";
import { MASK_SENTINEL } from "#shared/db/settings.ts";
import { describeWithEnv, expectFlash, expectRedirect } from "#test-utils";
import {
  formFrom,
  lastLogMessage,
  makeMockErrorPage,
  runHandler,
} from "#test-utils/settings-handlers.ts";

/** A secretFieldHandler for the "api_key" field with a spy save, plus that spy. */
const makeSecret = (
  overrides: Partial<Parameters<typeof secretFieldHandler>[0]> = {},
) => {
  const saveFn = fn(() => Promise.resolve());
  const handler = secretFieldHandler({
    field: "api_key",
    formId: "settings-secret",
    label: "API key",
    save: saveFn as (v: string) => Promise<void>,
    ...overrides,
  });
  return { handler, saveFn };
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
    mockErrorPage = makeMockErrorPage();
  });

  test("redirects with 'unchanged' flash and skips save for sentinel value", async () => {
    const { handler, saveFn } = makeSecret();
    const res = await runHandler(
      handler,
      { api_key: MASK_SENTINEL },
      mockErrorPage,
    );

    expectRedirect(res, "/admin/settings");
    expect(saveFn).not.toHaveBeenCalled();
    expectFlash(res, "API key unchanged");
  });

  test("returns error when required field is cleared", async () => {
    const { handler, saveFn } = makeSecret({ required: true });
    const res = await runHandler(handler, { api_key: "" }, mockErrorPage);

    expect(res.status).toBe(400);
    expect(saveFn).not.toHaveBeenCalled();
    expect(mockErrorPage).toHaveBeenCalledWith(
      "API key is required",
      400,
      "settings-secret",
    );
  });

  test("redirects with 'cleared' flash when optional field is cleared", async () => {
    const { handler, saveFn } = makeSecret({ required: false });
    const res = await runHandler(handler, { api_key: "" }, mockErrorPage);

    expectRedirect(res, "/admin/settings");
    expect(saveFn).not.toHaveBeenCalled();
    expectFlash(res, "API key cleared");
  });

  test("saves, logs, and flashes 'updated successfully' for a new value", async () => {
    const { handler, saveFn } = makeSecret();
    const res = await runHandler(
      handler,
      { api_key: "new_secret_value" },
      mockErrorPage,
    );

    expectRedirect(res, "/admin/settings");
    expect(saveFn).toHaveBeenCalledWith("new_secret_value");
    expect(await lastLogMessage()).toBe("API key configured");
    expectFlash(res, "API key updated successfully");
  });

  test("calls errorPage and skips save when validation fails", async () => {
    const { handler, saveFn } = makeSecret({
      validate: (v) =>
        !v.startsWith("sk_") ? "Key must start with sk_" : null,
    });
    const res = await runHandler(
      handler,
      { api_key: "bad_key" },
      mockErrorPage,
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
    const afterSaveFn = fn(() => Promise.resolve());
    const { handler, saveFn } = makeSecret({
      afterSave: afterSaveFn as (v: string) => Promise<void>,
    });

    await runHandler(handler, { api_key: "new_value" }, mockErrorPage);

    expect(saveFn).toHaveBeenCalledWith("new_value");
    expect(afterSaveFn).toHaveBeenCalledWith("new_value");
  });

  describe("advanced redirect", () => {
    const ADVANCED_VALUES: { name: string; value: string }[] = [
      {
        name: "redirects to advanced page when advanced is true",
        value: "new_value",
      },
      {
        name: "redirects to advanced page for an 'unchanged' action",
        value: MASK_SENTINEL,
      },
      { name: "redirects to advanced page for a 'cleared' action", value: "" },
    ];

    for (const { name, value } of ADVANCED_VALUES) {
      test(name, async () => {
        const { handler } = makeSecret({ advanced: true });
        const res = await runHandler(
          handler,
          { api_key: value },
          mockErrorPage,
        );
        expectRedirect(res, "/admin/settings-advanced");
      });
    }
  });

  test("omits form= param from redirect when formId is not provided", async () => {
    const { handler } = makeSecret({ formId: undefined });
    const res = await runHandler(
      handler,
      { api_key: "new_value" },
      mockErrorPage,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").not.toContain("form=");
  });
});
