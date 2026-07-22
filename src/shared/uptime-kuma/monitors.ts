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

const sharedGroup = (
  monitors: UptimeKumaMonitor[],
): UptimeKumaMonitor | null => {
  const groups = monitors.filter(
    (monitor) =>
      monitor.type === "group" && monitor.name === UPTIME_KUMA_GROUP_NAME,
  );
  if (groups.length > 1) {
    throw new Error(
      `More than one Uptime Kuma group is named "${UPTIME_KUMA_GROUP_NAME}".`,
    );
  }
  const [group] = groups;
  return group === undefined ? null : group;
};

const siteMonitor = (
  monitors: UptimeKumaMonitor[],
  groupId: number,
  url: string,
): UptimeKumaMonitor | null => {
  const matches = monitors.filter(
    (monitor) =>
      monitor.type === "http" &&
      monitor.parent === groupId &&
      monitor.url === url,
  );
  if (matches.length > 1) {
    throw new Error(`More than one Uptime Kuma monitor checks ${url}.`);
  }
  const [match] = matches;
  return match === undefined ? null : match;
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

const load = (site: BuiltSite): Promise<UptimeKumaMonitorState> =>
  withConfiguredKuma<UptimeKumaMonitorState>(
    () => ({ kind: "unconfigured" }),
    (error) => ({ error: errorMessage(error), kind: "error" }),
    (config) =>
      withMonitors(config, (_client, monitors, group) => {
        if (group === null) return { kind: "missing" };
        const url = targetUrl(site);
        const monitor = siteMonitor(monitors, group.id, url);
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
      return withMonitors(config, async (client, monitors, existingGroup) => {
        const existing = existingGroup
          ? siteMonitor(monitors, existingGroup.id, targetUrl(site))
          : null;
        if (existing) {
          return okResult({ created: false, monitorId: existing.id });
        }
        const groupId =
          existingGroup === null
            ? await client.addMonitor(groupInput())
            : existingGroup.id;
        const monitorId = await client.addMonitor(
          siteInput(site, config, groupId, scheduledTaskKey),
        );
        return okResult({ created: true, monitorId });
      });
    },
  );

export const uptimeKumaMonitorService = { add, load };
