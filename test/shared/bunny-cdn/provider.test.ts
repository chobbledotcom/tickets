import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi, bunnyHostingProvider } from "#shared/bunny-cdn.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { restoreStubsAfterEach } from "#test-utils/mocks.ts";

describeWithEnv(
  "Bunny hosting provider",
  { env: { BUNNY_API_KEY: "test-key" } },
  () => {
    const stubs: { restore(): void }[] = [];
    restoreStubsAfterEach(stubs);

    test("names its required credential", () => {
      expect(bunnyHostingProvider.configEnvVar).toBe("BUNNY_API_KEY");
    });

    test("prepares pull-zone settings and every native secret", async () => {
      const pullZoneSettings: Record<string, unknown>[] = [];
      const secrets: [number, string, string][] = [];
      stubs.push(
        stub(bunnyCdnApi, "createEdgeScript", () =>
          Promise.resolve({
            defaultHostname: "child.b-cdn.net",
            ok: true,
            pullZoneId: 9,
            scriptId: 42,
          }),
        ),
        stub(bunnyCdnApi, "updatePullZone", (_id, settings) => {
          pullZoneSettings.push(settings);
          return Promise.resolve({ ok: true });
        }),
        stub(bunnyCdnApi, "setEdgeScriptSecret", (id, name, value) => {
          secrets.push([id, name, value]);
          return Promise.resolve({ ok: true });
        }),
      );

      expect(
        await bunnyHostingProvider.prepareSite("Child", "code", [
          ["DB_URL", "libsql://child"],
        ]),
      ).toEqual({
        defaultHostname: "child.b-cdn.net",
        hostingId: "42",
        ok: true,
      });
      expect(pullZoneSettings).toEqual([{ DisableCookies: false }]);
      expect(secrets).toEqual([
        [42, "DB_URL", "libsql://child"],
        [42, "BUNNY_SCRIPT_ID", "42"],
      ]);
    });

    test("rejects a non-numeric hosting id", async () => {
      expect(await bunnyHostingProvider.setSecrets("missing", [])).toEqual({
        error: "No hostingId",
        ok: false,
      });
    });

    test("stops setting secrets at the first provider failure", async () => {
      const names: string[] = [];
      stubs.push(
        stub(bunnyCdnApi, "setEdgeScriptSecret", (_id, name) => {
          names.push(name);
          return Promise.resolve(
            name === "SECOND"
              ? { error: "set failed", ok: false }
              : { ok: true },
          );
        }),
      );

      expect(
        await bunnyHostingProvider.setSecrets("42", [
          ["FIRST", "1"],
          ["SECOND", "2"],
          ["THIRD", "3"],
        ]),
      ).toEqual({ error: "set failed", ok: false });
      expect(names).toEqual(["FIRST", "SECOND"]);
    });
  },
);
