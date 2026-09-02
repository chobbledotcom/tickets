/**
 * Fetch Bugsink issue details as JSON, so an LLM can dig into a live error.
 * The command line lives in `bugs.ts`.
 */

import { parseArgs } from "@std/cli/parse-args";
import * as v from "valibot";
import { sort } from "#fp";
import { fetchText } from "#scripts/fetch-text.ts";
import { parseJsonWith } from "#scripts/read-json.ts";
import type { ScriptIo } from "#scripts/script-runner.ts";
import { isLocalHttpHost } from "#shared/local-host.ts";

export interface BugsConfig {
  apiKey: string;
  /** Bugsink site origin, without a trailing slash. */
  baseUrl: string;
  /** The URL origin every request, pagination included, stays inside. */
  origin: string;
}

const firstSetEnv = (
  getEnv: (key: string) => string | undefined,
  keys: string[],
): string | undefined =>
  keys.map(getEnv).find((value) => value !== undefined && value !== "");

export const bugsConfig = (
  getEnv: (key: string) => string | undefined,
): BugsConfig => {
  const baseUrl = firstSetEnv(getEnv, ["SENTRY_BASE_URL", "SENTRY_BASE"]);
  if (baseUrl === undefined) {
    throw new Error(
      "Set SENTRY_BASE_URL in .env, for example https://bugs.chobble.com",
    );
  }
  const apiKey = firstSetEnv(getEnv, ["SENTRY_API_KEY"]);
  if (apiKey === undefined) {
    throw new Error(
      "Set SENTRY_API_KEY in .env. Create the token in Bugsink under Tokens.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`SENTRY_BASE_URL is not a URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`SENTRY_BASE_URL must be an http or https URL: ${baseUrl}`);
  }
  // The API key rides every request as a Bearer token, so cleartext http is
  // for local networks only, the same rule as UPTIME_KUMA_URL.
  if (parsed.protocol === "http:" && !isLocalHttpHost(parsed.hostname)) {
    throw new Error(
      `SENTRY_BASE_URL must use HTTPS outside a local network: ${baseUrl}`,
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      `SENTRY_BASE_URL must not contain a query or fragment: ${baseUrl}`,
    );
  }
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    origin: parsed.origin,
  };
};

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Accept an issue page URL, a bare issue UUID, or a friendly issue id. */
export const parseIssueRef = (ref: string): string => {
  const uuid = UUID_PATTERN.exec(ref)?.[0];
  if (uuid !== undefined) return uuid;
  if (/^https?:\/\//i.test(ref)) {
    throw new Error(
      `No issue id found in ${ref}. Pass the issue page URL or an issue id.`,
    );
  }
  return ref;
};

const parseJsonBody = (text: string, url: string): unknown =>
  parseJsonWith((error) => {
    throw new Error(
      `Bugsink sent non-JSON for ${url}: ${(error as Error).message}`,
    );
  })(text);

const apiGet = async (config: BugsConfig, url: string): Promise<unknown> => {
  const result = await fetchText(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
  });
  if (!result.ok) {
    throw new Error(
      `Bugsink returned ${result.status} for ${url}: ${result.text.slice(0, 200)}`,
    );
  }
  return parseJsonBody(result.text, url);
};

/** Check the fields the tool uses, and hand back the full raw object. */
const getJson = async <S extends v.GenericSchema>(
  config: BugsConfig,
  url: string,
  schema: S,
): Promise<v.InferOutput<S>> => {
  const raw = await apiGet(config, url);
  const parsed = v.safeParse(schema, raw);
  if (!parsed.success) {
    const first = parsed.issues[0]!;
    throw new Error(
      `Bugsink sent an unexpected shape for ${url}: ${first.message} at ${
        v.getDotPath(first) ?? "root"
      }`,
    );
  }
  return raw as v.InferOutput<S>;
};

const IssueSchema = v.object({
  calculated_type: v.string(),
  calculated_value: v.nullable(v.string()),
  digested_event_count: v.number(),
  first_seen: v.string(),
  friendly_id: v.string(),
  id: v.string(),
  is_muted: v.boolean(),
  is_resolved: v.boolean(),
  last_seen: v.string(),
  project: v.number(),
  stored_event_count: v.number(),
});
type IssueRecord = v.InferOutput<typeof IssueSchema>;

/** The events list omits the payload; only the id is needed to fetch it. */
const EventListItemSchema = v.object({ id: v.string() });

const EventSchema = v.object({
  data: v.nullable(v.unknown()),
  id: v.string(),
  issue: v.string(),
  stacktrace_md: v.nullable(v.string()),
});

const ProjectSchema = v.object({
  id: v.number(),
  name: v.string(),
  slug: v.string(),
});
type ProjectRecord = v.InferOutput<typeof ProjectSchema>;

const listPageSchema = <S extends v.GenericSchema>(item: S) =>
  v.object({ next: v.nullable(v.string()), results: v.array(item) });

/** Pin a pagination URL to the configured origin and the canonical API, so a
 * tampered response cannot point the Bearer token somewhere else. */
const pinnedNextUrl = (config: BugsConfig, next: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(next);
  } catch {
    throw new Error(`Bugsink sent a pagination URL that is not a URL: ${next}`);
  }
  if (
    parsed.origin !== config.origin ||
    !parsed.pathname.startsWith("/api/canonical/0/")
  ) {
    throw new Error(
      `Bugsink sent a pagination URL outside its own canonical API: ${next}`,
    );
  }
  return parsed.href;
};

/** Read a cursor-paginated list until it runs out or reaches the limit. */
const listAll = async <S extends v.GenericSchema>(
  config: BugsConfig,
  firstUrl: string,
  item: S,
  limit: number,
): Promise<v.InferOutput<S>[]> => {
  const items: v.InferOutput<S>[] = [];
  let url: string | null = firstUrl;
  while (url !== null && items.length < limit) {
    const page: { next: string | null; results: v.InferOutput<S>[] } =
      await getJson(config, url, listPageSchema(item));
    items.push(...page.results);
    url = page.next === null ? null : pinnedNextUrl(config, page.next);
  }
  return items.slice(0, limit);
};

const apiIssueUrl = (config: BugsConfig, issueId: string): string =>
  `${config.baseUrl}/api/canonical/0/issues/${encodeURIComponent(issueId)}/`;

export interface IssueBundle {
  events: Record<string, unknown>[];
  issue: Record<string, unknown>;
  issue_url: string;
}

/** Fetch one issue plus its latest events, with the full event payloads. */
export const fetchIssueBundle = async (
  config: BugsConfig,
  ref: string,
  eventCount: number,
): Promise<IssueBundle> => {
  const issue = await getJson(
    config,
    apiIssueUrl(config, parseIssueRef(ref)),
    IssueSchema,
  );
  const eventsUrl = `${config.baseUrl}/api/canonical/0/events/?issue=${encodeURIComponent(issue.id)}&order=desc`;
  const latest = await listAll(
    config,
    eventsUrl,
    EventListItemSchema,
    eventCount,
  );
  const events: Record<string, unknown>[] = [];
  for (const listed of latest) {
    events.push(
      await getJson(
        config,
        `${config.baseUrl}/api/canonical/0/events/${listed.id}/`,
        EventSchema,
      ),
    );
  }
  return {
    events,
    issue,
    issue_url: `${config.baseUrl}/issues/issue/${issue.id}/`,
  };
};

export interface IssueSummary {
  events: number;
  first_seen: string;
  friendly_id: string;
  id: string;
  issue_url: string;
  last_seen: string;
  muted: boolean;
  project: string;
  project_id: number;
  stored_events: number;
  type: string;
  value: string | null;
}

const summarize =
  (baseUrl: string, project: ProjectRecord) =>
  (issue: IssueRecord): IssueSummary => ({
    events: issue.digested_event_count,
    first_seen: issue.first_seen,
    friendly_id: issue.friendly_id,
    id: issue.id,
    issue_url: `${baseUrl}/issues/issue/${issue.id}/`,
    last_seen: issue.last_seen,
    muted: issue.is_muted,
    project: project.name,
    project_id: project.id,
    stored_events: issue.stored_event_count,
    type: issue.calculated_type,
    value: issue.calculated_value,
  });

/** List the issues of every project, newest first. */
export const fetchIssueSummaries = async (
  config: BugsConfig,
  includeResolved: boolean,
): Promise<IssueSummary[]> => {
  const projects = await listAll(
    config,
    `${config.baseUrl}/api/canonical/0/projects/`,
    ProjectSchema,
    Number.POSITIVE_INFINITY,
  );
  const summaries: IssueSummary[] = [];
  for (const project of projects) {
    const issuesUrl = `${config.baseUrl}/api/canonical/0/issues/?project=${project.id}&sort=last_seen&order=desc`;
    const issues = await listAll(
      config,
      issuesUrl,
      IssueSchema,
      Number.POSITIVE_INFINITY,
    );
    summaries.push(
      ...issues
        .filter((issue) => includeResolved || !issue.is_resolved)
        .map(summarize(config.baseUrl, project)),
    );
  }
  return sort((a: IssueSummary, b: IssueSummary) =>
    b.last_seen.localeCompare(a.last_seen),
  )(summaries);
};

export const USAGE = `Fetch Bugsink issue details as JSON.

Usage: deno task bugs <issue-url-or-id>... [--events N]
       deno task bugs list [--all]

Options:
  --events N   Fetch the latest N events per issue. Default 1. 0 prints the issue only.
  --all        With list, also print resolved issues.
  -h, --help   Print this text.

Reads SENTRY_BASE_URL (or SENTRY_BASE) and SENTRY_API_KEY from .env.
Create a token in Bugsink under Tokens.
`;

const wholeNumber = (text: string): number | undefined =>
  /^\d+$/.test(text) ? Number(text) : undefined;

export const runBugsCli = async (io: ScriptIo): Promise<number> => {
  const flags = parseArgs(io.args, {
    alias: { h: "help" },
    boolean: ["all", "help"],
    string: ["events"],
  });
  if (flags.help || flags._.length === 0) {
    io.stderr(USAGE);
    return flags.help ? 0 : 1;
  }
  const eventCount = wholeNumber(flags.events ?? "1");
  if (eventCount === undefined) {
    io.stderr(
      `The --events value must be a whole number, got: ${flags.events}`,
    );
    io.stderr(USAGE);
    return 1;
  }
  try {
    const config = bugsConfig(io.getEnv);
    const refs = flags._.map((value) => String(value));
    if (refs[0] === "list") {
      if (refs.length > 1) {
        io.stderr("The list command takes no issue ids.");
        return 1;
      }
      io.stdout(
        JSON.stringify(await fetchIssueSummaries(config, flags.all), null, 2),
      );
      return 0;
    }
    const bundles: IssueBundle[] = [];
    for (const ref of refs) {
      io.stderr(`Fetching ${ref}`);
      bundles.push(await fetchIssueBundle(config, ref, eventCount));
    }
    io.stdout(
      JSON.stringify(bundles.length === 1 ? bundles[0] : bundles, null, 2),
    );
    return 0;
  } catch (error) {
    io.stderr(`error: ${(error as Error).message}`);
    return 1;
  }
};
