import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type RemoveWebhooks, removePreview } from "#scripts/preview/remove.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  apiOn,
  type FailureCase,
  type FakeBunny,
  type FakeBunnyOptions,
  fakeBunny,
  reportsEachFailure,
} from "./fake-bunny.ts";

const NAMES = {
  databaseName: "preview-feature-abc123",
  scriptName: "Tickets - preview-feature-abc123",
};

/** Webhook removal that records the hosts it gets and what Bunny held at the
 * time, and answers with `answer`. */
const webhooks = (answer: Result<string[]> = okResult([])) => {
  const seen: { hosts: readonly string[]; writes: number }[] = [];
  return {
    remove:
      (bunny: FakeBunny): RemoveWebhooks =>
      (hosts) => {
        seen.push({ hosts, writes: bunny.writes().length });
        return Promise.resolve(answer);
      },
    seen,
  };
};

const remove = (bunny: FakeBunny, hooks = webhooks()) =>
  removePreview(apiOn(bunny), NAMES, hooks.remove(bunny));

/** The preview of the branch: script 1, its pull zone 1001, database db-2. */
const withPreview = (bunny: FakeBunny) => {
  bunny.addScript(NAMES.scriptName);
  bunny.addDatabase(NAMES.databaseName);
};

const sizes = (bunny: FakeBunny) => [
  bunny.scripts.size,
  bunny.pullZones.size,
  bunny.databases.size,
];

/** One delete against a prepared account, and what it leaves. */
type Scenario = {
  expected: unknown;
  name: string;
  observe: (bunny: FakeBunny, result: unknown) => unknown;
  options?: FakeBunnyOptions;
  seed: (bunny: FakeBunny) => void;
};

const SCENARIOS: Scenario[] = [
  {
    expected: {
      remains: [0, 0, 0],
      result: {
        ok: true,
        value: ["script 1", "pull zone 1001", "database db-2"],
      },
    },
    name: "deletes the script, its pull zone, and the database",
    observe: (bunny, result) => ({ remains: sizes(bunny), result }),
    seed: withPreview,
  },
  {
    expected: ["compute", "pullzone", "database"],
    name: "deletes the database last",
    observe: (bunny) => bunny.writes().map((call) => call.path.split("/")[1]),
    seed: withPreview,
  },
  {
    expected: { databases: 0, ok: true },
    name: "succeeds when the script already took its pull zone with it",
    observe: (bunny, result) => ({
      databases: bunny.databases.size,
      ok: (result as { ok: boolean }).ok,
    }),
    options: { cascadePullZone: true },
    seed: withPreview,
  },
  {
    expected: { ok: true, value: ["database db-1"] },
    name: "finishes the work when only the database is left",
    observe: (_bunny, result) => result,
    seed: (bunny) => {
      bunny.addDatabase(NAMES.databaseName);
    },
  },
  {
    expected: { result: { ok: true, value: [] }, writes: [] },
    name: "succeeds with nothing to delete when the preview is gone",
    observe: (bunny, result) => ({ result, writes: bunny.writes() }),
    seed: () => {},
  },
  {
    expected: {
      databases: ["preview-other-ffffff", "production"],
      scripts: ["Tickets - preview-other-ffffff", "Tickets - production"],
    },
    name: "leaves other scripts and databases alone",
    observe: (bunny) => ({
      databases: [...bunny.databases.values()].map((db) => db.name),
      scripts: [...bunny.scripts.values()].map((script) => script.name),
    }),
    seed: (bunny) => {
      withPreview(bunny);
      bunny.addScript("Tickets - preview-other-ffffff");
      bunny.addScript("Tickets - production");
      bunny.addDatabase("preview-other-ffffff");
      bunny.addDatabase("production");
    },
  },
  {
    expected: {
      databases: 1,
      result: {
        error:
          "Delete pull zone failed (500): boom Pull zone 1001 must be deleted by hand.",
        ok: false,
      },
    },
    name: "names the pull zone that cannot be deleted, and keeps the database",
    observe: (bunny, result) => ({ databases: bunny.databases.size, result }),
    options: { fails: { "DELETE /pullzone/1001": 500 } },
    seed: withPreview,
  },
  {
    expected: 1,
    name: "keeps the database when the script delete fails",
    observe: (bunny) => bunny.databases.size,
    options: { fails: { "DELETE /compute/script/1": 500 } },
    seed: withPreview,
  },
];

/* jscpd:ignore-start -- static data, not code */
const FAILURES: FailureCase[] = [
  ["the script list", { "GET /compute/script": 500 }],
  ["the script read", { "GET /compute/script/1": 500 }],
  ["the script delete", { "DELETE /compute/script/1": 500 }],
  ["the database list", { "GET /database/v2/databases": 500 }],
  ["the database delete", { "DELETE /database/v2/databases/db-2": 500 }],
];
/* jscpd:ignore-end */

describe("removePreview", () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      const bunny = fakeBunny(scenario.options);
      scenario.seed(bunny);

      const result = await remove(bunny);

      expect(scenario.observe(bunny, result)).toEqual(scenario.expected);
    });
  }

  reportsEachFailure(FAILURES, (bunny) => remove(bunny), withPreview);

  test("deletes the webhooks of both hosts of the site before it deletes anything", async () => {
    const bunny = fakeBunny();
    withPreview(bunny);
    const hooks = webhooks(okResult(["Stripe webhook we_1"]));

    const result = await remove(bunny, hooks);

    expect(hooks.seen).toEqual([
      { hosts: ["site-1.bunny.run", "site-1.b-cdn.net"], writes: 0 },
    ]);
    expect(result).toEqual({
      ok: true,
      value: [
        "Stripe webhook we_1",
        "script 1",
        "pull zone 1001",
        "database db-2",
      ],
    });
  });

  test("keeps the whole preview when the webhooks cannot be deleted", async () => {
    const bunny = fakeBunny();
    withPreview(bunny);

    const result = await remove(
      bunny,
      webhooks(errorResult("Stripe said no.")),
    );

    expect(result).toEqual({ error: "Stripe said no.", ok: false });
    expect([bunny.writes().length, ...sizes(bunny)]).toEqual([0, 1, 1, 1]);
  });

  test("asks for no webhook removal when the script is already gone", async () => {
    const bunny = fakeBunny();
    const hooks = webhooks();

    await remove(bunny, hooks);

    expect(hooks.seen).toEqual([]);
  });
});
