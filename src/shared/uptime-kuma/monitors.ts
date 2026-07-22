import type { BuiltSite } from "#shared/db/built-sites/types.ts";
import { siteBaseUrl } from "#shared/db/built-sites.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  type UptimeKumaClient,
  type UptimeKumaMonitor,
  type UptimeKumaMonitorInput,
  uptimeKumaClientApi,
} from "./client.ts";
import {
  getEnabledUptimeKumaConfigOrNull,
  type UptimeKumaConfig,
} from "./config.ts";

export const UPTIME_KUMA_GROUP_NAME = "Chobble Tickets";

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

const targetUrl = (site: BuiltSite): string =>
  `${siteBaseUrl(site.siteUrl)}/scheduled`;

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

const matchingSiteMonitors = (
  monitors: UptimeKumaMonitor[],
  groupIds: number[],
  url: string,
): UptimeKumaMonitor[] =>
  monitors.filter(
    (monitor) =>
      monitor.type === "http" &&
      monitor.parent !== null &&
      groupIds.includes(monitor.parent) &&
      monitor.method === "POST" &&
      monitor.url === url,
  );

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
  allowRaceDuplicates: boolean,
): UptimeKumaMonitor | null => {
  const matches = matchingSiteMonitors(monitors, groupIds, url);
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
  const createdGroupId = await client.addMonitor(groupInput());
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

const monitorDefaults = (
  type: "group" | "http",
  name: string,
  parent: number | null,
): UptimeKumaMonitorInput => ({
  accepted_statuscodes: ["200-299"],
  authMethod: "",
  body: null,
  databaseConnectionString: null,
  description: null,
  dns_resolve_server: "1.1.1.1",
  dns_resolve_type: "A",
  expiryNotification: false,
  headers: null,
  hostname: null,
  httpBodyEncoding: "json",
  ignoreTls: false,
  interval: 60,
  maxredirects: 10,
  maxretries: 1,
  method: "GET",
  mqttPassword: "",
  mqttSuccessMessage: "",
  mqttTopic: "",
  mqttUsername: "",
  name,
  notificationIDList: {},
  packetSize: 56,
  parent,
  port: null,
  proxyId: null,
  resendInterval: 0,
  retryInterval: 60,
  timeout: 48,
  type,
  upsideDown: false,
  url: null,
});

const groupInput = (): UptimeKumaMonitorInput =>
  monitorDefaults("group", UPTIME_KUMA_GROUP_NAME, null);

const siteInput = (
  site: BuiltSite,
  config: UptimeKumaConfig,
  parent: number,
  scheduledTaskKey: string,
): UptimeKumaMonitorInput => ({
  ...monitorDefaults("http", site.name, parent),
  headers: JSON.stringify({
    Authorization: `Bearer ${scheduledTaskKey}`,
  }),
  interval: config.intervalSeconds,
  method: "POST",
  url: targetUrl(site),
});

const finishMonitorAdd = async (
  client: UptimeKumaClient,
  monitors: UptimeKumaMonitor[],
  url: string,
  monitorId: number,
  ownedGroupId: number | null,
): Promise<AddedMonitor> => {
  const winner = siteMonitor(
    monitors,
    sharedGroups(monitors).map((group) => group.id),
    url,
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
): Promise<AddedMonitor> => {
  const currentMonitors = await client.getMonitors();
  const raceWinner = siteMonitor(
    currentMonitors,
    sharedGroups(currentMonitors).map((candidate) => candidate.id),
    url,
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
    siteInput(site, config, group.group.id, scheduledTaskKey),
  );
  return await finishMonitorAdd(
    client,
    await client.getMonitors(),
    url,
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
  const url = targetUrl(site);
  const existing = existingGroup
    ? siteMonitor(monitors, [existingGroup.id], url, false)
    : null;
  if (existing) {
    return okResult({ created: false, monitorId: existing.id });
  }
  const group = await groupForAdd(client, existingGroup);
  return okResult(
    await addToGroup(client, site, config, scheduledTaskKey, group, url),
  );
};

const load = (site: BuiltSite): Promise<UptimeKumaMonitorState> =>
  withConfiguredKuma<UptimeKumaMonitorState>(
    () => ({ kind: "unconfigured" }),
    (error) => ({ error: errorMessage(error), kind: "error" }),
    (config) =>
      withMonitors(config, (_client, monitors, group) => {
        if (group === null) return { kind: "missing" };
        const url = targetUrl(site);
        const monitor = siteMonitor(monitors, [group.id], url, false);
        return monitor === null
          ? { kind: "missing" }
          : { kind: "found", monitor: monitorDetails(monitor, url) };
      }),
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
