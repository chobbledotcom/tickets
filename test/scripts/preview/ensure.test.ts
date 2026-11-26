import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type EnsureInput, ensurePreview } from "#scripts/preview/ensure.ts";
import {
  apiOn,
  type FailureCase,
  type FakeBunny,
  fakeBunny,
  reportsEachFailure,
} from "./fake-bunny.ts";

const NAMES = {
  databaseName: "preview-feature-abc123",
  scriptName: "Tickets - preview-feature-abc123",
};

const DATABASE_URL = "libsql://preview-feature-abc123.example";

const ALL_SECRETS = [
  "DB_URL",
  "DB_TOKEN",
  "DB_ENCRYPTION_KEY",
  "SCHEDULED_TASK_KEY",
  "BUNNY_SCRIPT_ID",
  "STORAGE_ZONE_NAME",
  "STORAGE_ZONE_KEY",
  "HOST_EMAIL_PROVIDER",
  "HOST_EMAIL_API_KEY",
  "HOST_EMAIL_FROM_ADDRESS",
];

const input = (): EnsureInput => ({
  code: "bundle code",
  copiedSecrets: [
    ["STORAGE_ZONE_NAME", "staging-zone"],
    ["STORAGE_ZONE_KEY", "zone-key"],
    ["HOST_EMAIL_PROVIDER", "resend"],
    ["HOST_EMAIL_API_KEY", "mail-key"],
    ["HOST_EMAIL_FROM_ADDRESS", "tickets@example.com"],
  ],
  names: NAMES,
  newEncryptionKey: () => "new-encryption-key",
  newScheduledTaskKey: () => "new-task-key",
});

const run = (bunny: FakeBunny) => ensurePreview(apiOn(bunny), input());

const secretWrites = (bunny: FakeBunny): string[] =>
  bunny
    .writes()
    .filter((call) => call.path.endsWith("/secrets"))
    .map((call) => (call.body as { Name: string }).Name);

const databaseCalls = (bunny: FakeBunny): number =>
  bunny.calls.filter((call) => call.path.startsWith("/database")).length;

const withDatabase = (bunny: FakeBunny) =>
  bunny.addDatabase(NAMES.databaseName);

/** A script that holds every secret except these. */
const scriptWithout =
  (...missing: string[]) =>
  (bunny: FakeBunny) => {
    bunny.addScript(
      NAMES.scriptName,
      ALL_SECRETS.filter((name) => !missing.includes(name)),
    );
  };

/** One run against a prepared account, and what it leaves. */
type Scenario = {
  expected: unknown;
  name: string;
  observe: (bunny: FakeBunny, result: unknown) => unknown;
  seed?: (bunny: FakeBunny) => void;
};

const siteOf = (id: number, published: boolean) => ({
  ok: true,
  value: { published, scriptId: id, siteUrl: `https://site-${id}.bunny.run` },
});

const SCENARIOS: Scenario[] = [
  {
    expected: {
      code: "bundle code",
      cookies: true,
      databases: [NAMES.databaseName],
      published: true,
      result: siteOf(1, true),
      secrets: {
        BUNNY_SCRIPT_ID: "1",
        DB_ENCRYPTION_KEY: "new-encryption-key",
        DB_TOKEN: "token-db-2-1",
        DB_URL: DATABASE_URL,
        HOST_EMAIL_API_KEY: "mail-key",
        HOST_EMAIL_FROM_ADDRESS: "tickets@example.com",
        HOST_EMAIL_PROVIDER: "resend",
        SCHEDULED_TASK_KEY: "new-task-key",
        STORAGE_ZONE_KEY: "zone-key",
        STORAGE_ZONE_NAME: "staging-zone",
      },
      tokens: [1],
    },
    name: "creates the database, the script, and every secret, then publishes",
    observe: (bunny, result) => {
      const script = bunny.scripts.get(1);
      return {
        code: script?.code,
        cookies: script?.cookiesAllowed,
        databases: [...bunny.databases.values()].map((db) => db.name),
        published: script?.published,
        result,
        secrets: Object.fromEntries(script?.secrets ?? []),
        tokens: [...bunny.databases.values()].map((db) => db.tokens),
      };
    },
  },
  {
    expected: { afterEverySecret: true, last: "publish", secretWrites: 10 },
    name: "publishes only after every secret is written",
    observe: (bunny) => {
      const order = bunny.writes().map((call) => call.path.split("/").pop());
      return {
        afterEverySecret:
          order.indexOf("publish") > order.lastIndexOf("secrets"),
        last: order.at(-1),
        secretWrites: order.filter((step) => step === "secrets").length,
      };
    },
  },
  {
    expected: { result: siteOf(2, true), writes: ["SCHEDULED_TASK_KEY"] },
    name: "writes only the missing secrets of a half-made preview",
    observe: (bunny, result) => ({ result, writes: secretWrites(bunny) }),
    seed: (bunny) => {
      withDatabase(bunny);
      scriptWithout("SCHEDULED_TASK_KEY")(bunny);
    },
  },
  {
    expected: { key: "kept", writes: false },
    name: "never writes a secret that exists, so the database key stays",
    observe: (bunny) => ({
      key: bunny.scripts.get(1)?.secrets.get("DB_ENCRYPTION_KEY"),
      writes: secretWrites(bunny).includes("DB_ENCRYPTION_KEY"),
    }),
    seed: (bunny) => {
      bunny.addScript(NAMES.scriptName, ["DB_ENCRYPTION_KEY"]);
      withDatabase(bunny);
    },
  },
  {
    expected: { databases: ["db-1"], url: DATABASE_URL },
    name: "reuses the database that a failed run made",
    observe: (bunny) => ({
      databases: [...bunny.databases.keys()],
      url: bunny.scripts.get(2)?.secrets.get("DB_URL"),
    }),
    seed: (bunny) => {
      withDatabase(bunny);
      bunny.addScript(NAMES.scriptName);
    },
  },
  {
    expected: [NAMES.databaseName],
    name: "makes the database when only the script was left",
    observe: (bunny) => [...bunny.databases.values()].map((db) => db.name),
    seed: (bunny) => {
      bunny.addScript(NAMES.scriptName, ["DB_URL"]);
    },
  },
  {
    expected: 0,
    name: "does not touch the database when only a generated key is missing",
    observe: databaseCalls,
    seed: scriptWithout("DB_ENCRYPTION_KEY"),
  },
  {
    expected: true,
    name: "allows cookies again before it writes",
    observe: (bunny) => bunny.scripts.get(1)?.cookiesAllowed,
    seed: (bunny) => {
      bunny.addScript(NAMES.scriptName, ["DB_URL"]);
      withDatabase(bunny);
    },
  },
  {
    expected: { published: false, scripts: 2 },
    name: "does not touch the script of another branch",
    observe: (bunny) => ({
      published: bunny.scripts.get(1)?.published,
      scripts: bunny.scripts.size,
    }),
    seed: (bunny) => {
      bunny.addScript("Tickets - preview-other-ffffff", ALL_SECRETS);
    },
  },
];

/* jscpd:ignore-start -- static data, not code */
const FAILURES: FailureCase[] = [
  ["the script list", { "GET /compute/script": 500 }],
  ["the script create", { "POST /compute/script": 500 }],
  ["the secret list", { "GET /compute/script/1/secrets": 500 }],
  ["the cookie setting", { "POST /pullzone/1001": 500 }],
  ["the database list", { "GET /database/v2/databases": 500 }],
  ["the database create", { "POST /database/v2/databases": 500 }],
  ["the database read", { "GET /database/v2/databases/db-2": 500 }],
  [
    "the token request",
    { "PUT /database/v2/databases/db-2/auth/generate": 500 },
  ],
  ["a secret write", { "PUT /compute/script/1/secrets": 500 }],
  ["the code upload", { "POST /compute/script/1/code": 500 }],
  ["the publish", { "POST /compute/script/1/publish": 500 }],
];
/* jscpd:ignore-end */

describe("ensurePreview", () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      const bunny = fakeBunny();
      scenario.seed?.(bunny);

      const result = await run(bunny);

      expect(scenario.observe(bunny, result)).toEqual(scenario.expected);
    });
  }

  test("changes nothing and reads no database for a complete preview", async () => {
    const bunny = fakeBunny();
    await run(bunny);
    bunny.calls.length = 0;

    const result = await run(bunny);

    expect(result).toEqual(siteOf(1, false));
    expect(bunny.writes()).toEqual([]);
    expect(databaseCalls(bunny)).toBe(0);
  });

  reportsEachFailure(FAILURES, run);

  test("never publishes after a failed secret write", async () => {
    const bunny = fakeBunny({
      fails: { "PUT /compute/script/1/secrets": 500 },
    });

    await run(bunny);

    expect(bunny.scripts.get(1)?.published).toBe(false);
  });

  reportsEachFailure(
    [["the read of an existing script", { "GET /compute/script/1": 500 }]],
    run,
    (bunny) => {
      bunny.addScript(NAMES.scriptName);
    },
  );
});
