import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import type { ErrorPageFn } from "#routes/admin/settings-helpers.ts";
import { createSettingsHandler } from "#routes/admin/settings-helpers.ts";
import { describeWithEnv, expectFlash, expectRedirect } from "#test-utils";
import {
  lastLogMessage,
  makeMockErrorPage,
  runHandler,
} from "#test-utils/settings-handlers.ts";

/** A createSettingsHandler reading "value" with a spy save, plus that spy. */
const makeCreate = (
  overrides: Partial<Parameters<typeof createSettingsHandler>[0]> = {},
) => {
  const saveFn = fn(() => Promise.resolve());
  const handler = createSettingsHandler({
    extract: (form) => form.getString("value"),
    formId: "settings-test",
    label: "Test",
    save: saveFn,
    ...overrides,
  } as Parameters<typeof createSettingsHandler>[0]);
  return { handler, saveFn };
};

describeWithEnv("createSettingsHandler", { db: true }, () => {
  let mockErrorPage: ErrorPageFn & ReturnType<typeof fn>;

  beforeEach(() => {
    mockErrorPage = makeMockErrorPage();
  });

  test("redirects with flash on success", async () => {
    const { handler, saveFn } = makeCreate({ label: "Test setting" });
    const res = await runHandler(handler, { value: "hello" }, mockErrorPage);

    expectRedirect(res, "/admin/settings", "form=settings-test");
    expectFlash(res, "Test setting updated");
    expect(saveFn).toHaveBeenCalledWith("hello");
    expect(await lastLogMessage()).toBe("Test setting updated");
  });

  test("uses custom log fn for activity log and flash message", async () => {
    const { handler } = makeCreate({ log: (v) => `Set to ${v}` });
    const res = await runHandler(handler, { value: "y" }, mockErrorPage);

    expect(await lastLogMessage()).toBe("Set to y");
    expectFlash(res, "Set to y");
  });

  const VALIDATION_CASES: {
    name: string;
    validate: (v: unknown) => string | null | Promise<string | null>;
    message: string;
  }[] = [
    {
      message: "Value is required",
      name: "calls errorPage and skips save when validation fails",
      validate: (v) => (v === "" ? "Value is required" : null),
    },
    {
      message: "Async error",
      name: "async validator is awaited before save",
      validate: (v) => Promise.resolve(v === "" ? "Async error" : null),
    },
  ];

  for (const { name, validate, message } of VALIDATION_CASES) {
    test(name, async () => {
      const { handler, saveFn } = makeCreate({ validate });
      const res = await runHandler(handler, { value: "" }, mockErrorPage);

      expect(res.status).toBe(400);
      expect(saveFn).not.toHaveBeenCalled();
      expect(mockErrorPage).toHaveBeenCalledWith(message, 400, "settings-test");
    });
  }

  test("proceeds without calling errorPage when no validate function provided", async () => {
    const { handler, saveFn } = makeCreate();
    const res = await runHandler(handler, { value: "" }, mockErrorPage);

    expect(res.status).toBe(302);
    expect(saveFn).toHaveBeenCalledWith("");
    expect(mockErrorPage).not.toHaveBeenCalled();
  });

  describe("redirect targets", () => {
    test("redirects to /admin/settings-advanced when advanced is true", async () => {
      const { handler } = makeCreate({ advanced: true });
      const res = await runHandler(handler, { value: "x" }, mockErrorPage);
      expectRedirect(res, "/admin/settings-advanced");
    });

    test("redirects to custom path when redirectTo is set", async () => {
      const { handler } = makeCreate({
        formId: undefined,
        redirectTo: "/admin/site",
      });
      const res = await runHandler(handler, { value: "x" }, mockErrorPage);
      expectRedirect(res, "/admin/site");
    });

    test("omits form= param from redirect when formId is not provided", async () => {
      const { handler } = makeCreate({
        formId: undefined,
        redirectTo: "/admin/site",
      });
      const res = await runHandler(handler, { value: "x" }, mockErrorPage);
      const location = res.headers.get("location") ?? "";
      expect(location).not.toContain("form=");
    });

    test("passes empty formId to errorPage when formId is not set", async () => {
      const { handler } = makeCreate({
        formId: undefined,
        redirectTo: "/admin/site",
        validate: () => "error",
      });
      await runHandler(handler, { value: "x" }, mockErrorPage);
      expect(mockErrorPage).toHaveBeenCalledWith("error", 400, "");
    });
  });
});
