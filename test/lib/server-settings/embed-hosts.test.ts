import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import { adminFormPost, describeWithEnv, expectFlash } from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/settings/embed-hosts", () => {
    test("clears embed hosts when empty", async () => {
      const { response } = await adminFormPost("/admin/settings/embed-hosts", {
        embed_hosts: "   ",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Embed host restrictions removed"),
      );
      expect(settings.embedHosts).toBe("");
    });

    test("rejects invalid embed host pattern", async () => {
      const { response } = await adminFormPost("/admin/settings/embed-hosts", {
        embed_hosts: "*",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Bare wildcard"), false);
    });

    test("normalizes and saves embed hosts", async () => {
      const { response } = await adminFormPost("/admin/settings/embed-hosts", {
        embed_hosts: "Example.com, *.Sub.Example.com",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Allowed embed hosts updated"),
      );
      expect(settings.embedHosts).toBe("example.com, *.sub.example.com");
    });
  });
});
