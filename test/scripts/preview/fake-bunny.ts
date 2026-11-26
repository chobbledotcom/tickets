import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { FetchText, FetchTextResult } from "#scripts/fetch-text.ts";
import { type PreviewApi, previewApi } from "#scripts/preview/bunny-api.ts";
import type { Result } from "#shared/result.ts";

export type Call = { body: unknown; method: string; path: string };

type FakeScript = {
  code: string;
  cookiesAllowed: boolean;
  hostname: string;
  id: number;
  name: string;
  published: boolean;
  pullZoneId: number;
  secrets: Map<string, string>;
};

type FakeDatabase = { id: string; name: string; tokens: number };

export type FakeBunnyOptions = {
  /** Deleting a script also deletes its pull zone. */
  cascadePullZone?: boolean;
  /** Answer `"METHOD /path"` with this status and a Bunny error body. */
  fails?: Record<string, number>;
  /** Text that starts every default hostname. Bunny can answer a hostname
   * that already holds its scheme. */
  hostnamePrefix?: string;
  /** Items per page for both lists. */
  pageSize?: number;
};

type Body = Record<string, string | boolean | null> | undefined;

/** What one route handler reads: the body, the path captures, the query. */
type Request = { body: Body; captures: string[]; query: URLSearchParams };

const answer = (status: number, body: unknown): FetchTextResult => ({
  ok: status >= 200 && status < 300,
  status,
  text: typeof body === "string" ? body : JSON.stringify(body),
});

const NOT_FOUND = (what: string): FetchTextResult =>
  answer(404, { Message: `no ${what}` });

/** One page of a list. */
const page = <T>(
  items: T[],
  query: URLSearchParams,
  pageSize: number,
): { hasMore: boolean; items: T[] } => {
  const start = (Number(query.get("page")) - 1) * pageSize;
  return {
    hasMore: start + pageSize < items.length,
    items: items.slice(start, start + pageSize),
  };
};

/** An in-memory Bunny account that answers the HTTP calls a preview makes. */
export const fakeBunny = (options: FakeBunnyOptions = {}) => {
  const calls: Call[] = [];
  const scripts = new Map<number, FakeScript>();
  const pullZones = new Set<number>();
  const databases = new Map<string, FakeDatabase>();
  const pageSize = options.pageSize ?? 100;
  let nextId = 1;

  const addScript = (name: string, secretNames: string[] = []): FakeScript => {
    const id = nextId++;
    const script: FakeScript = {
      code: "",
      cookiesAllowed: false,
      hostname: `${options.hostnamePrefix ?? ""}site-${id}.bunny.run`,
      id,
      name,
      published: false,
      pullZoneId: 1000 + id,
      secrets: new Map(secretNames.map((secret) => [secret, "kept"])),
    };
    scripts.set(id, script);
    pullZones.add(script.pullZoneId);
    return script;
  };

  const addDatabase = (name: string): FakeDatabase => {
    const database = { id: `db-${nextId++}`, name, tokens: 0 };
    databases.set(database.id, database);
    return database;
  };

  /** Run a handler on the script that the first capture names. */
  const onScript =
    (run: (script: FakeScript, request: Request) => FetchTextResult) =>
    (request: Request): FetchTextResult => {
      const script = scripts.get(Number(request.captures[0]));
      return script === undefined ? NOT_FOUND("script") : run(script, request);
    };

  const onDatabase =
    (run: (database: FakeDatabase) => FetchTextResult) =>
    (request: Request): FetchTextResult => {
      const database = databases.get(request.captures[0] as string);
      return database === undefined ? NOT_FOUND("database") : run(database);
    };

  const scriptSummary = (script: FakeScript) => ({
    DefaultHostname: script.hostname,
    LinkedPullZones: [{ Id: script.pullZoneId }],
  });

  const stampOnScript = (stamp: (script: FakeScript, body: Body) => void) =>
    onScript((script, { body }) => {
      stamp(script, body);
      return answer(204, "");
    });

  const toggleCookies = (request: Request): FetchTextResult => {
    const id = Number(request.captures[0]);
    if (!pullZones.has(id)) return NOT_FOUND("pull zone");
    for (const script of scripts.values()) {
      if (script.pullZoneId === id) {
        script.cookiesAllowed = request.body?.DisableCookies === false;
      }
    }
    return answer(204, "");
  };

  type Route = [
    method: string,
    pattern: RegExp,
    handler: (r: Request) => FetchTextResult,
  ];

  const routes: Route[] = [
    [
      "GET",
      /^\/compute\/script$/,
      ({ query }) => {
        const listed = page([...scripts.values()], query, pageSize);
        return answer(200, {
          HasMoreItems: listed.hasMore,
          Items: listed.items.map(({ id, name }) => ({ Id: id, Name: name })),
        });
      },
    ],
    [
      "POST",
      /^\/compute\/script$/,
      ({ body }) => {
        const script = addScript(body?.Name as string);
        script.code = body?.Code as string;
        return answer(200, { ...scriptSummary(script), Id: script.id });
      },
    ],
    [
      "GET",
      /^\/compute\/script\/(\d+)$/,
      onScript((script) => answer(200, scriptSummary(script))),
    ],
    [
      "DELETE",
      /^\/compute\/script\/(\d+)$/,
      onScript((script) => {
        scripts.delete(script.id);
        if (options.cascadePullZone) pullZones.delete(script.pullZoneId);
        return answer(204, "");
      }),
    ],
    [
      "GET",
      /^\/compute\/script\/(\d+)\/secrets$/,
      onScript((script) =>
        answer(200, {
          Secrets: [...script.secrets.keys()].map((Name) => ({ Name })),
        }),
      ),
    ],
    [
      "PUT",
      /^\/compute\/script\/(\d+)\/secrets$/,
      stampOnScript((script, body) =>
        script.secrets.set(body?.Name as string, body?.Secret as string),
      ),
    ],
    [
      "POST",
      /^\/compute\/script\/(\d+)\/code$/,
      stampOnScript((script, body) => {
        script.code = body?.Code as string;
      }),
    ],
    [
      "POST",
      /^\/compute\/script\/(\d+)\/publish$/,
      stampOnScript((script) => {
        script.published = true;
      }),
    ],
    ["POST", /^\/pullzone\/(\d+)$/, toggleCookies],
    [
      "DELETE",
      /^\/pullzone\/(\d+)$/,
      (request) => {
        const id = Number(request.captures[0]);
        if (!pullZones.delete(id)) return NOT_FOUND("pull zone");
        return answer(204, "");
      },
    ],
    [
      "GET",
      /^\/database\/v1\/config$/,
      () =>
        answer(200, {
          primary_regions: [{ id: "DE" }, { id: "NY" }],
          replica_regions: [{ id: "UK" }],
        }),
    ],
    [
      "GET",
      /^\/database\/v2\/databases$/,
      ({ query }) => {
        const listed = page([...databases.values()], query, pageSize);
        return answer(200, {
          databases: listed.items.map(({ id, name }) => ({ id, name })),
          page_info: { has_more_items: listed.hasMore },
        });
      },
    ],
    [
      "POST",
      /^\/database\/v2\/databases$/,
      ({ body }) =>
        answer(200, { db_id: addDatabase(body?.name as string).id }),
    ],
    [
      "GET",
      /^\/database\/v2\/databases\/([\w-]+)$/,
      onDatabase((database) =>
        answer(200, { db: { url: `libsql://${database.name}.example` } }),
      ),
    ],
    [
      "DELETE",
      /^\/database\/v2\/databases\/([\w-]+)$/,
      onDatabase((database) => {
        databases.delete(database.id);
        return answer(204, "");
      }),
    ],
    [
      "PUT",
      /^\/database\/v2\/databases\/([\w-]+)\/auth\/generate$/,
      onDatabase((database) => {
        database.tokens += 1;
        return answer(200, {
          token: `token-${database.id}-${database.tokens}`,
        });
      }),
    ],
  ];

  const route = (
    method: string,
    path: string,
    query: URLSearchParams,
    body: Body,
  ): FetchTextResult => {
    for (const [routeMethod, pattern, handler] of routes) {
      const match = routeMethod === method ? pattern.exec(path) : null;
      if (match !== null)
        return handler({ body, captures: match.slice(1), query });
    }
    return answer(404, { Message: `unrouted ${method} ${path}` });
  };

  const fetchText: FetchText = (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? "GET";
    const body =
      typeof init.body === "string"
        ? (JSON.parse(init.body) as Body)
        : undefined;
    calls.push({ body, method, path: pathname });
    const failure = options.fails?.[`${method} ${pathname}`];
    return Promise.resolve(
      failure === undefined
        ? route(method, pathname, searchParams, body)
        : answer(failure, { Message: "boom" }),
    );
  };

  return {
    addDatabase,
    addScript,
    calls,
    databases,
    fetchText,
    pullZones,
    scripts,
    /** The calls that change something. */
    writes: () => calls.filter((call) => call.method !== "GET"),
  };
};

export type FakeBunny = ReturnType<typeof fakeBunny>;

/** A fake account with the options and the seed of one table row. */
export const seededBunny = ({
  options,
  seed,
}: {
  options?: FakeBunnyOptions;
  seed?: (bunny: FakeBunny) => void;
}): FakeBunny => {
  const bunny = fakeBunny(options);
  seed?.(bunny);
  return bunny;
};

/** The preview calls, aimed at a fake account. */
export const apiOn = (bunny: FakeBunny): PreviewApi =>
  previewApi({ accessKey: "staging-key", fetchText: bunny.fetchText });

/** The preview calls, aimed at a server that answers every request with one
 * successful body. */
export const apiAnswering = (body: unknown): PreviewApi =>
  previewApi({
    accessKey: "staging-key",
    fetchText: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: typeof body === "string" ? body : JSON.stringify(body),
      }),
  });

/** One step that fails, and the routes that make it fail. */
export type FailureCase = [step: string, fails: Record<string, number>];

/** A test for each failure: the run stops and reports Bunny's error. */
export const reportsEachFailure = (
  cases: FailureCase[],
  run: (bunny: FakeBunny) => Promise<Result<unknown>>,
  seed: (bunny: FakeBunny) => void = () => {},
): void => {
  for (const [step, fails] of cases) {
    test(`stops and reports ${step}`, async () => {
      const bunny = fakeBunny({ fails });
      seed(bunny);

      expect(await run(bunny)).toEqual({
        error: expect.stringContaining("(500): boom"),
        ok: false,
      });
    });
  }
};
