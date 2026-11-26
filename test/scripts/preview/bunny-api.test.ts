import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type DatabaseId,
  type PreviewApi,
  type PullZoneId,
  previewApi,
  type ScriptId,
} from "#scripts/preview/bunny-api.ts";
import {
  apiAnswering,
  apiOn,
  type FakeBunny,
  type FakeBunnyOptions,
  fakeBunny,
  seededBunny,
} from "./fake-bunny.ts";

const OK = { ok: true, value: undefined };

// The api takes branded ids. A test names a fake id by a plain value.
const script = (id: number) => id as ScriptId;
const zone = (id: number) => id as PullZoneId;
const database = (id: string) => id as DatabaseId;

/** One call against a fake account, what it returns, and what it leaves. */
type Check = {
  expected: unknown;
  name: string;
  observe?: (bunny: FakeBunny) => unknown;
  observed?: unknown;
  options?: FakeBunnyOptions;
  run: (api: PreviewApi) => Promise<unknown>;
  seed?: (bunny: FakeBunny) => void;
};

const withScript = (bunny: FakeBunny) => bunny.addScript("x");
const withDatabase = (bunny: FakeBunny) => bunny.addDatabase("preview-x");

const CHECKS: Check[] = [
  {
    expected: {
      ok: true,
      value: { defaultHostname: "site-1.bunny.run", id: 1, pullZoneId: 1001 },
    },
    name: "creates a script with a linked pull zone",
    observe: (bunny) => bunny.calls[0]?.body,
    observed: {
      Code: "code",
      CreateLinkedPullZone: true,
      Name: "Tickets - x",
      ScriptType: 1,
    },
    run: (api) => api.createScript("Tickets - x", "code"),
  },
  {
    expected: {
      ok: true,
      value: { defaultHostname: "site-1.bunny.run", pullZoneId: 1001 },
    },
    name: "reads the hostname and pull zone of a script",
    run: (api) => api.getScript(script(1)),
    seed: withScript,
  },
  {
    expected: { ok: true, value: ["A", "B"] },
    name: "lists secret names",
    run: (api) => api.listSecretNames(script(1)),
    seed: (bunny) => bunny.addScript("x", ["A", "B"]),
  },
  {
    expected: { ok: true, value: { id: 5, name: "e" } },
    name: "finds a script on a later page",
    observe: (bunny) => bunny.calls.length,
    // Five scripts at two a page need three requests.
    observed: 3,
    options: { pageSize: 2 },
    run: (api) => api.scriptNamedOrNull("e"),
    seed: (bunny) => {
      for (const name of ["a", "b", "c", "d", "e"]) bunny.addScript(name);
    },
  },
  {
    expected: { ok: true, value: null },
    name: "answers null for a script that is not there",
    run: (api) => api.scriptNamedOrNull("missing"),
    seed: withScript,
  },
  {
    expected: { ok: true, value: { id: "db-2", name: "two" } },
    name: "finds a database on a later page",
    options: { pageSize: 1 },
    run: (api) => api.databaseNamedOrNull("two"),
    seed: (bunny) => {
      bunny.addDatabase("one");
      bunny.addDatabase("two");
    },
  },
  {
    expected: { ok: true, value: null },
    name: "answers null for a database that is not there",
    run: (api) => api.databaseNamedOrNull("missing"),
  },
  {
    expected: OK,
    name: "allows cookies on a pull zone",
    observe: (bunny) => [bunny.scripts.get(1)?.cookiesAllowed, bunny.calls[0]],
    observed: [
      true,
      {
        body: { DisableCookies: false },
        method: "POST",
        path: "/pullzone/1001",
      },
    ],
    run: (api) => api.allowCookies(zone(1001)),
    seed: withScript,
  },
  {
    expected: OK,
    name: "uploads then publishes the code",
    observe: (bunny) => [
      bunny.scripts.get(1)?.code,
      bunny.scripts.get(1)?.published,
    ],
    observed: ["new code", true],
    run: (api) => api.deployCode(script(1), "new code"),
    seed: withScript,
  },
  {
    expected: { ok: true, value: "db-1" },
    name: "creates a one-region database with no replicas",
    observe: (bunny) => bunny.calls.at(-1)?.body,
    observed: {
      name: "preview-x",
      primary_regions: ["DE"],
      replicas_regions: [],
      storage_region: "eu-west-1",
    },
    run: (api) => api.createDatabase("preview-x"),
  },
  {
    expected: { ok: true, value: "libsql://preview-x.example" },
    name: "reads the database URL",
    run: (api) => api.databaseUrl(database("db-1")),
    seed: withDatabase,
  },
  {
    expected: { ok: true, value: "token-db-1-1" },
    name: "issues a full-access token",
    observe: (bunny) => bunny.calls.at(-1)?.body,
    observed: { authorization: "full-access", expires_at: null },
    run: (api) => api.issueDatabaseToken(database("db-1")),
    seed: withDatabase,
  },
  {
    expected: OK,
    name: "sets a secret by name",
    observe: (bunny) => bunny.scripts.get(1)?.secrets.get("DB_URL"),
    observed: "libsql://x",
    run: (api) => api.setSecret(script(1), "DB_URL", "libsql://x"),
    seed: withScript,
  },
  {
    expected: [OK, OK, OK],
    name: "deletes a script, a pull zone, and a database by id",
    observe: (bunny) => [
      bunny.scripts.size,
      bunny.pullZones.size,
      bunny.databases.size,
    ],
    observed: [0, 0, 0],
    run: async (api) => [
      await api.deleteScript(script(1)),
      await api.deletePullZone(zone(1001)),
      await api.deleteDatabase(database("db-2")),
    ],
    seed: (bunny) => {
      withScript(bunny);
      withDatabase(bunny);
    },
  },
  {
    expected: [OK, OK, OK],
    name: "counts a missing resource as deleted",
    run: async (api) => [
      await api.deleteScript(script(9)),
      await api.deletePullZone(zone(9)),
      await api.deleteDatabase(database("gone")),
    ],
  },
];

/** The text of a server answer, and what the client makes of it. */
type Answer = {
  expected: unknown;
  name: string;
  run: (api: PreviewApi) => Promise<unknown>;
  text: unknown;
};

const SCRIPT_WITHOUT = (field: object) => ({
  DefaultHostname: "x.bunny.run",
  Id: 4,
  LinkedPullZones: [{ Id: 5 }],
  ...field,
});

const ANSWERS: Answer[] = [
  {
    expected: { ok: true, value: [] },
    name: "reads a null secret list as empty",
    run: (api) => api.listSecretNames(script(1)),
    text: { Secrets: null },
  },
  {
    expected: {
      error: "List scripts gave an answer this script cannot read.",
      ok: false,
    },
    name: "refuses a script list that lacks a field",
    run: (api) => api.scriptNamedOrNull("x"),
    text: { Items: [] },
  },
  {
    expected: {
      error: "List databases gave an answer this script cannot read.",
      ok: false,
    },
    name: "refuses an answer that is not JSON",
    run: (api) => api.databaseNamedOrNull("x"),
    text: "<html>",
  },
  {
    expected: {
      error: "Get script gave a script with no hostname or pull zone.",
      ok: false,
    },
    name: "refuses a script with no hostname",
    run: (api) => api.getScript(script(1)),
    text: SCRIPT_WITHOUT({ DefaultHostname: "" }),
  },
  {
    expected: {
      error: "Create script gave a script with no hostname or pull zone.",
      ok: false,
    },
    name: "refuses a created script with no pull zone",
    run: (api) => api.createScript("n", "c"),
    text: SCRIPT_WITHOUT({ LinkedPullZones: [] }),
  },
  {
    expected: {
      error: "Get database config listed no primary region.",
      ok: false,
    },
    name: "refuses a database config with no primary region",
    run: (api) => api.createDatabase("n"),
    text: { primary_regions: [] },
  },
];

describe("previewApi", () => {
  for (const check of CHECKS) {
    test(check.name, async () => {
      const bunny = seededBunny(check);

      expect(await check.run(apiOn(bunny))).toEqual(check.expected);
      expect(check.observe?.(bunny)).toEqual(check.observed);
    });
  }

  test("names the call and the status when Bunny refuses it", async () => {
    const bunny = fakeBunny({
      fails: {
        "GET /database/v1/config": 500,
        "PUT /compute/script/1/secrets": 400,
        "PUT /database/v2/databases/db-2/auth/generate": 403,
      },
    });
    withScript(bunny);
    withDatabase(bunny);
    const api = apiOn(bunny);

    expect(await api.setSecret(script(1), "DB_URL", "v")).toEqual({
      error: "Set secret DB_URL failed (400): boom",
      ok: false,
    });
    expect(await api.issueDatabaseToken(database("db-2"))).toEqual({
      error: "Generate database token failed (403): boom",
      ok: false,
    });
    expect(await api.createDatabase("preview-x")).toEqual({
      error: "Get database config failed (500): boom",
      ok: false,
    });
  });

  test("refuses to allow cookies on a pull zone that Bunny does not know", async () => {
    expect(await apiOn(fakeBunny()).allowCookies(zone(9))).toEqual({
      error: "Allow pull zone cookies failed (404): no pull zone",
      ok: false,
    });
  });

  for (const answer of ANSWERS) {
    test(answer.name, async () => {
      expect(await answer.run(apiAnswering(answer.text))).toEqual(
        answer.expected,
      );
    });
  }

  test("sends the account key on every request", async () => {
    const seen: (string | undefined)[] = [];
    const bunny = fakeBunny();
    const api = previewApi({
      accessKey: "staging-key",
      fetchText: (url, init) => {
        seen.push((init.headers as Record<string, string>).AccessKey);
        return bunny.fetchText(url, init);
      },
    });

    await api.scriptNamedOrNull("x");
    await api.createDatabase("db");

    // One list call, then the region read and the create call.
    expect(seen).toEqual(["staging-key", "staging-key", "staging-key"]);
  });
});
