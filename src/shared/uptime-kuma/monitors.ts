import { t } from "#i18n";
import type { BuiltSite } from "#shared/db/built-sites/types.ts";
import { normalizePath } from "#shared/path.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  type UptimeKumaClient,
  type UptimeKumaMonitor,
  uptimeKumaClientApi,
} from "./client.ts";
import {
  getEnabledUptimeKumaConfigOrNull,
  type UptimeKumaConfig,
} from "./config.ts";
import {
  groupMonitorInput,
  scheduledAuthorization,
  scheduledUrl,
  siteMonitorInput,
  UPTIME_KUMA_GROUP_NAME,
} from "./monitor-input.ts";

export type UptimeKumaMonitorDetails = {
  active: boolean;
  group: string;
  id: number;
  intervalSeconds: number;
  method: string;
  name: string;
  url: string;
};

export type UptimeKumaMonitorState =
  | { kind: "unconfigured" }
  | { error: string; kind: "error" }
  | { kind: "missing" }
  | { kind: "found"; monitor: UptimeKumaMonitorDetails };

type AddedMonitor = { created: boolean; monitorId: number };

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return "Uptime Kuma failed.";
};

const sharedGroups = (monitors: UptimeKumaMonitor[]): UptimeKumaMonitor[] =>
  monitors.filter(
    (monitor) =>
      monitor.type === "group" && monitor.name === UPTIME_KUMA_GROUP_NAME,
  );

const hasAuthorization = (
  headers: string | null,
  authorization: string,
): boolean => {
  if (headers === null) return false;
  try {
    const value: unknown = JSON.parse(headers);
    return (
      typeof value === "object" &&
      value !== null &&
      Object.entries(value).some(
        ([name, header]) =>
          name.toLowerCase() === "authorization" && header === authorization,
      )
    );
  } catch {
    // A malformed custom header belongs to a different, broken monitor.
    return false;
  }
};

const acceptsScheduledResponse = (statusCodes: string[]): boolean =>
  statusCodes.some((range) => {
    const parts = range.split("-");
    const minimum = Number(parts[0]);
    const maximum = Number(parts[1] === undefined ? parts[0] : parts[1]);
    return minimum <= 204 && maximum >= 204;
  });

const scheduledTarget = (value: string): string => {
  const url = new URL(value);
  return `${url.origin}${normalizePath(url.pathname)}`;
};

const lowestByIdOrNull = (
  monitors: UptimeKumaMonitor[],
): UptimeKumaMonitor | null => {
  const [first] = monitors.toSorted((left, right) => left.id - right.id);
  return first === undefined ? null : first;
};

const firstById = (
  monitors: UptimeKumaMonitor[],
  missingMessage: string,
): UptimeKumaMonitor => {
  const first = lowestByIdOrNull(monitors);
  if (first === null) throw new Error(missingMessage);
  return first;
};

const siteMonitor = (
  monitors: UptimeKumaMonitor[],
  groupIds: number[],
  url: string,
  authorization: string,
  allowRaceDuplicates: boolean,
): UptimeKumaMonitor | null => {
  const target = scheduledTarget(url);
  const matches = monitors.filter(
    (monitor) =>
      monitor.type === "http" &&
      monitor.parent !== null &&
      groupIds.includes(monitor.parent) &&
      monitor.method === "POST" &&
      monitor.url !== null &&
      scheduledTarget(monitor.url) === target &&
      acceptsScheduledResponse(monitor.acceptedStatusCodes) &&
      hasAuthorization(monitor.headers, authorization),
  );
  if (!allowRaceDuplicates && matches.length > 1) {
    throw new Error(`More than one Uptime Kuma monitor checks ${url}.`);
  }
  return matches.length === 0
    ? null
    : firstById(matches, `Uptime Kuma did not return a monitor for ${url}.`);
};

const groupForAdd = async (
  client: UptimeKumaClient,
  groups: UptimeKumaMonitor[],
  majorVersion: number,
): Promise<UptimeKumaMonitor> => {
  const existing = lowestByIdOrNull(groups);
  if (existing !== null) return existing;
  await client.addMonitor(groupMonitorInput(majorVersion));
  return firstById(
    sharedGroups(await client.getMonitors()),
    `Uptime Kuma did not return the new "${UPTIME_KUMA_GROUP_NAME}" group.`,
  );
};

const monitorDetails = (
  monitor: UptimeKumaMonitor,
  url: string,
): UptimeKumaMonitorDetails => ({
  active: monitor.active,
  group: UPTIME_KUMA_GROUP_NAME,
  id: monitor.id,
  intervalSeconds: monitor.interval,
  method: monitor.method,
  name: monitor.name,
  url,
});

const withClient = async <Value>(
  config: UptimeKumaConfig,
  use: (client: UptimeKumaClient) => Promise<Value>,
): Promise<Value> => {
  const client = await uptimeKumaClientApi.connect(config);
  try {
    await client.login(config.username, config.password);
    return await use(client);
  } finally {
    client.disconnect();
  }
};

const withMonitors = <Value>(
  config: UptimeKumaConfig,
  use: (
    client: UptimeKumaClient,
    monitors: UptimeKumaMonitor[],
    groups: UptimeKumaMonitor[],
  ) => Promise<Value> | Value,
): Promise<Value> =>
  withClient(config, async (client) => {
    const monitors = await client.getMonitors();
    return await use(client, monitors, sharedGroups(monitors));
  });

const withConfiguredKuma = async <Value>(
  unavailable: () => Value,
  failed: (error: unknown) => Value,
  use: (config: UptimeKumaConfig) => Promise<Value>,
): Promise<Value> => {
  const config = getEnabledUptimeKumaConfigOrNull();
  if (config === null) return unavailable();
  try {
    return await use(config);
  } catch (error) {
    return failed(error);
  }
};

const monitorInSharedGroups =
  (allowRaceDuplicates: boolean) =>
  (
    monitors: UptimeKumaMonitor[],
    url: string,
    authorization: string,
  ): UptimeKumaMonitor | null =>
    siteMonitor(
      monitors,
      sharedGroups(monitors).map((group) => group.id),
      url,
      authorization,
      allowRaceDuplicates,
    );

const existingSiteMonitor = monitorInSharedGroups(false);
const raceWinnerMonitor = monitorInSharedGroups(true);

const finishMonitorAdd = async (
  client: UptimeKumaClient,
  monitors: UptimeKumaMonitor[],
  url: string,
  authorization: string,
  monitorId: number,
): Promise<AddedMonitor> => {
  const winner = raceWinnerMonitor(monitors, url, authorization);
  if (winner === null) {
    throw new Error(`Uptime Kuma did not return the new monitor for ${url}.`);
  }
  const created = winner.id === monitorId;
  if (created) return { created, monitorId };
  const createdMonitorExists = monitors.some(
    (monitor) => monitor.id === monitorId,
  );
  if (createdMonitorExists) await client.deleteMonitor(monitorId);
  return { created, monitorId: winner.id };
};

const addToGroup = async (
  client: UptimeKumaClient,
  site: BuiltSite,
  config: UptimeKumaConfig,
  scheduledTaskKey: string,
  group: UptimeKumaMonitor,
  url: string,
  authorization: string,
  majorVersion: number,
): Promise<AddedMonitor> => {
  const currentMonitors = await client.getMonitors();
  const raceWinner = raceWinnerMonitor(currentMonitors, url, authorization);
  if (raceWinner !== null) {
    return { created: false, monitorId: raceWinner.id };
  }
  const monitorId = await client.addMonitor(
    siteMonitorInput(site, config, group.id, scheduledTaskKey, majorVersion),
  );
  return await finishMonitorAdd(
    client,
    await client.getMonitors(),
    url,
    authorization,
    monitorId,
  );
};

const addFromMonitors = async (
  client: UptimeKumaClient,
  monitors: UptimeKumaMonitor[],
  groups: UptimeKumaMonitor[],
  site: BuiltSite,
  config: UptimeKumaConfig,
  scheduledTaskKey: string,
): Promise<Result<AddedMonitor>> => {
  const url = scheduledUrl(site);
  const authorization = scheduledAuthorization(scheduledTaskKey);
  const existing = existingSiteMonitor(monitors, url, authorization);
  if (existing) {
    return okResult({ created: false, monitorId: existing.id });
  }
  const majorVersion = await client.getMajorVersion();
  const group = await groupForAdd(client, groups, majorVersion);
  return okResult(
    await addToGroup(
      client,
      site,
      config,
      scheduledTaskKey,
      group,
      url,
      authorization,
      majorVersion,
    ),
  );
};

const loadConfigured = (
  site: BuiltSite,
  config: UptimeKumaConfig,
): Promise<UptimeKumaMonitorState> => {
  const scheduledTaskKey = site.scheduledTaskKey;
  if (scheduledTaskKey === null) return Promise.resolve({ kind: "missing" });
  return withMonitors(config, (_client, monitors, groups) => {
    if (groups.length === 0) return { kind: "missing" };
    const url = scheduledUrl(site);
    const monitor = existingSiteMonitor(
      monitors,
      url,
      scheduledAuthorization(scheduledTaskKey),
    );
    return monitor === null
      ? { kind: "missing" }
      : { kind: "found", monitor: monitorDetails(monitor, url) };
  });
};

const load = (site: BuiltSite): Promise<UptimeKumaMonitorState> =>
  withConfiguredKuma<UptimeKumaMonitorState>(
    () => ({ kind: "unconfigured" }),
    (error) => ({ error: errorMessage(error), kind: "error" }),
    (config) => loadConfigured(site, config),
  );

const add = (site: BuiltSite): Promise<Result<AddedMonitor>> =>
  withConfiguredKuma<Result<AddedMonitor>>(
    () => errorResult(t("built_sites.kuma_add_unconfigured")),
    (error) => errorResult(errorMessage(error)),
    (config) => {
      const scheduledTaskKey = site.scheduledTaskKey;
      if (scheduledTaskKey === null) {
        return Promise.resolve(errorResult(t("built_sites.kuma_needs_key")));
      }
      return withMonitors(config, (client, monitors, groups) =>
        addFromMonitors(
          client,
          monitors,
          groups,
          site,
          config,
          scheduledTaskKey,
        ),
      );
    },
  );

export const uptimeKumaMonitorService = { add, load };
