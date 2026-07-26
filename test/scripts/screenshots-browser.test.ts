import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";

describe("screenshot Chromium executable", () => {
  test("uses the CHROMIUM_EXECUTABLE env var", async () => {
    using _env = stub(Deno.env, "get", (key) =>
      key === "CHROMIUM_EXECUTABLE" ? "/custom/chromium" : undefined,
    );

    expect(await chromiumExecutable()).toBe("/custom/chromium");
  });

  test("falls back to the Nix profile path", async () => {
    using _env = stub(Deno.env, "get", () => undefined);
    using _stat = stub(Deno, "stat", () =>
      Promise.resolve({} as Deno.FileInfo),
    );

    expect(await chromiumExecutable()).toBe(
      "/etc/profiles/per-user/user/bin/chromium",
    );
  });

  test("returns undefined when the Nix path is absent", async () => {
    using _env = stub(Deno.env, "get", () => undefined);
    using _stat = stub(Deno, "stat", () =>
      Promise.reject(new Deno.errors.NotFound()),
    );

    expect(await chromiumExecutable()).toBe(undefined);
  });

  test("rethrows other filesystem errors", async () => {
    using _env = stub(Deno.env, "get", () => undefined);
    using _stat = stub(Deno, "stat", () =>
      Promise.reject(new Deno.errors.PermissionDenied("no access")),
    );

    await expect(chromiumExecutable()).rejects.toThrow("no access");
  });
});
