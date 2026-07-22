import type { BuiltSite } from "#shared/db/built-sites/types.ts";
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

const sharedGroup = (
  monitors: UptimeKumaMonitor[],
): UptimeKumaMonitor | null => {
  const groups = sharedGroups(monitors);
  if (groups.length > 1) {
    throw new Error(
      `More than one Uptime Kuma group is named "${UPTIME_KUMA_GROUP_NAME}".`,
    );
  }
  const [group] = groups;
  return group === undefined ? null : group;
};

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

const firstById = (
  monitors: UptimeKumaMonitor[],
  missingMessage: string,
): UptimeKumaMonitor => {
  const [first] = monitors.toSorted((left, right) => left.id - right.id);
  if (first === undefined) throw new Error(missingMessage);
  return first;
};

const siteMonitor = (
  monitors: UptimeKumaMonitor[],
  groupIds: number[],
  url: string,
  authorization: string,
  allowRaceDuplicates: boolean,
): UptimeKumaMonitor | null => {
  const matches = monitors.filter(
    (monitor) =>
      monitor.type === "http" &&
      monitor.parent !== null &&
      groupIds.includes(monitor.parent) &&
      monitor.method === "POST" &&
      monitor.url === url &&
      hasAuthorization(monitor.headers, authorization),
  );
  if (!allowRaceDuplicates && matches.length > 1) {
    throw new Error(`More than one Uptime Kuma monitor checks ${url}.`);
  }
  return matches.length === 0
    ? null
    : firstById(matches, `Uptime Kuma did not return a monitor for ${url}.`);
};

type GroupForAdd = {
  group: UptimeKumaMonitor;
  ownedGroupId: number | null;
};

const groupForAdd = async (
  client: UptimeKumaClient,
  existingGroup: UptimeKumaMonitor | null,
): Promise<GroupForAdd> => {
  if (existingGroup !== null) {
    return { group: existingGroup, ownedGroupId: null };
  }
  const createdGroupId = await client.addMonitor(groupMonitorInput());
  const groups = sharedGroups(await client.getMonitors());
  const group = firstById(
    groups,
    `Uptime Kuma did not return the new "${UPTIME_KUMA_GROUP_NAME}" group.`,
  );
  const createdGroupStillExists = groups.some(
    (candidate) => candidate.id === createdGroupId,
  );
  if (group.id !== createdGroupId && createdGroupStillExists) {
    await client.deleteMonitor(createdGroupId);
  }
  return {
    group,
    ownedGroupId: group.id === createdGroupId ? createdGroupId : null,
  };
};

const deleteOwnedGroupIfEmpty = async (
  client: UptimeKumaClient,
  monitors: UptimeKumaMonitor[],
  ownedGroupId: number | null,
  keptGroupId: number | null,
  ignoredMonitorId?: number,
): Promise<void> => {
  if (
    ownedGroupId !== null &&
    ownedGroupId !== keptGroupId &&
    !monitors.some(
      (monitor) =>
        monitor.parent === ownedGroupId && monitor.id !== ignoredMonitorId,
    )
  ) {
    await client.deleteMonitor(ownedGroupId);
  }
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
    group: UptimeKumaMonitor | null,
  ) => Promise<Value> | Value,
): Promise<Value> =>
  withClient(config, async (client) => {
    const monitors = await client.getMonitors();
    return await use(client, monitors, sharedGroup(monitors));
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

const finishMonitorAdd = async (
  client: UptimeKumaClient,
  monitors: UptimeKumaMonitor[],
  url: string,
  authorization: string,
  monitorId: number,
  ownedGroupId: number | null,
): Promise<AddedMonitor> => {
  const winner = siteMonitor(
    monitors,
    sharedGroups(monitors).map((group) => group.id),
    url,
    authorization,
    true,
  );
  if (winner === null) {
    throw new Error(`Uptime Kuma did not return the new monitor for ${url}.`);
  }
  const created = winner.id === monitorId;
  if (created) return { created, monitorId };
  const createdMonitorExists = monitors.some(
    (monitor) => monitor.id === monitorId,
  );
  if (createdMonitorExists) await client.deleteMonitor(monitorId);
  await deleteOwnedGroupIfEmpty(
    client,
    monitors,
    ownedGroupId,
    winner.parent,
    monitorId,
  );
  return { created, monitorId: winner.id };
};

const addToGroup = async (
  client: UptimeKumaClient,
  site: BuiltSite,
  config: UptimeKumaConfig,
  scheduledTaskKey: string,
  group: GroupForAdd,
  url: string,
  authorization: string,
): Promise<AddedMonitor> => {
  const currentMonitors = await client.getMonitors();
  const raceWinner = siteMonitor(
    currentMonitors,
    sharedGroups(currentMonitors).map((candidate) => candidate.id),
    url,
    authorization,
    true,
  );
  if (raceWinner !== null) {
    await deleteOwnedGroupIfEmpty(
      client,
      currentMonitors,
      group.ownedGroupId,
      raceWinner.parent,
    );
    return { created: false, monitorId: raceWinner.id };
  }
  const monitorId = await client.addMonitor(
    siteMonitorInput(site, config, group.group.id, scheduledTaskKey),
  );
  return await finishMonitorAdd(
    client,
    await client.getMonitors(),
    url,
    authorization,
    monitorId,
    group.ownedGroupId,
  );
};

const addFromMonitors = async (
  client: UptimeKumaClient,
  monitors: UptimeKumaMonitor[],
  existingGroup: UptimeKumaMonitor | null,
  site: BuiltSite,
  config: UptimeKumaConfig,
  scheduledTaskKey: string,
): Promise<Result<AddedMonitor>> => {
  const url = scheduledUrl(site);
  const authorization = scheduledAuthorization(scheduledTaskKey);
  const existing = existingGroup
    ? siteMonitor(monitors, [existingGroup.id], url, authorization, false)
    : null;
  if (existing) {
    return okResult({ created: false, monitorId: existing.id });
  }
  const group = await groupForAdd(client, existingGroup);
  return okResult(
    await addToGroup(
      client,
      site,
      config,
      scheduledTaskKey,
      group,
      url,
      authorization,
    ),
  );
};

const loadConfigured = (
  site: BuiltSite,
  config: UptimeKumaConfig,
): Promise<UptimeKumaMonitorState> => {
  const scheduledTaskKey = site.scheduledTaskKey;
  if (scheduledTaskKey === null) return Promise.resolve({ kind: "missing" });
  return withMonitors(config, (_client, monitors, group) => {
    if (group === null) return { kind: "missing" };
    const url = scheduledUrl(site);
    const monitor = siteMonitor(
      monitors,
      [group.id],
      url,
      scheduledAuthorization(scheduledTaskKey),
      false,
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
    () => errorResult("Uptime Kuma is not configured."),
    (error) => errorResult(errorMessage(error)),
    (config) => {
      const scheduledTaskKey = site.scheduledTaskKey;
      if (scheduledTaskKey === null) {
        return Promise.resolve(
          errorResult(
            "Set up scheduled maintenance before adding this monitor.",
          ),
        );
      }
      return withMonitors(config, (client, monitors, existingGroup) =>
        addFromMonitors(
          client,
          monitors,
          existingGroup,
          site,
          config,
          scheduledTaskKey,
        ),
      );
    },
  );

export const uptimeKumaMonitorService = { add, load };
