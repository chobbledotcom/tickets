import { stub } from "@std/testing/mock";
import type { BuiltSite } from "#shared/db/built-sites/types.ts";
import type {
  UptimeKumaClient,
  UptimeKumaMonitor,
} from "#shared/uptime-kuma/client.ts";
import { uptimeKumaClientApi } from "#shared/uptime-kuma/client.ts";
import {
  scheduledAuthorization,
  UPTIME_KUMA_GROUP_NAME,
} from "#shared/uptime-kuma/monitor-input.ts";
import { uptimeKumaMonitorService } from "#shared/uptime-kuma/monitors.ts";
import { withEnv } from "#test-utils/env.ts";
import { testBuiltSite } from "#test-utils/factories.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";

export const kumaEnv = {
  CAN_BUILD_SITES: "true",
  UPTIME_KUMA_PASSWORD: "password",
  UPTIME_KUMA_URL: "https://kuma.example.test",
  UPTIME_KUMA_USERNAME: "owner",
};

export const group = (id = 11): UptimeKumaMonitor => ({
  acceptedStatusCodes: ["200-299"],
  active: true,
  authorization: null,
  id,
  interval: 60,
  method: "GET",
  name: UPTIME_KUMA_GROUP_NAME,
  parent: null,
  type: "group",
  url: null,
});

export const siteMonitor = (
  parent = 11,
  acceptedStatusCodes = ["200-299"],
): UptimeKumaMonitor => ({
  acceptedStatusCodes,
  active: true,
  authorization: scheduledAuthorization(TEST_SCHEDULED_KEY),
  id: 22,
  interval: 900,
  method: "POST",
  name: "Child site",
  parent,
  type: "http",
  url: "https://child.example.test/scheduled",
});

type AddedMonitor = Record<string, unknown>;

type FakeClient = {
  added: AddedMonitor[];
  client: UptimeKumaClient;
  deleted: number[];
  disconnected: () => boolean;
};

const listedMonitor = (
  id: number,
  monitor: AddedMonitor,
): UptimeKumaMonitor => ({
  acceptedStatusCodes: Array.isArray(monitor.accepted_statuscodes)
    ? monitor.accepted_statuscodes.map(String)
    : [],
  active: true,
  authorization:
    typeof monitor.headers === "string"
      ? scheduledAuthorization(TEST_SCHEDULED_KEY)
      : null,
  id,
  interval: typeof monitor.interval === "number" ? monitor.interval : 60,
  method: typeof monitor.method === "string" ? monitor.method : "GET",
  name: typeof monitor.name === "string" ? monitor.name : "",
  parent: typeof monitor.parent === "number" ? monitor.parent : null,
  type: typeof monitor.type === "string" ? monitor.type : "",
  url: typeof monitor.url === "string" ? monitor.url : null,
});

type ConnectedFake = FakeClient & Disposable;

const fakeClient = (
  monitors: UptimeKumaMonitor[],
  beforeDelete?: (id: number) => void,
  majorVersion = 2,
): FakeClient => {
  const added: AddedMonitor[] = [];
  const deleted: number[] = [];
  let currentMonitors = [...monitors];
  let disconnected = false;
  let nextId = 100;
  const client: UptimeKumaClient = {
    addMonitor: (monitor) => {
      const id = nextId++;
      added.push(monitor);
      currentMonitors.push(listedMonitor(id, monitor));
      return Promise.resolve(id);
    },
    deleteMonitor: (id) => {
      beforeDelete?.(id);
      deleted.push(id);
      currentMonitors = currentMonitors.filter((monitor) => monitor.id !== id);
      return Promise.resolve();
    },
    disconnect: () => {
      disconnected = true;
    },
    getMajorVersion: () => Promise.resolve(majorVersion),
    getMonitors: () => Promise.resolve(currentMonitors),
    login: () => Promise.resolve(),
  };
  return { added, client, deleted, disconnected: () => disconnected };
};

const connectClient = (fake: FakeClient): ConnectedFake => {
  const connection = stub(uptimeKumaClientApi, "connect", () =>
    Promise.resolve(fake.client),
  );
  return {
    ...fake,
    [Symbol.dispose]: () => connection.restore(),
  };
};

export const connectFake = (
  monitors: UptimeKumaMonitor[],
  majorVersion = 2,
): ConnectedFake =>
  connectClient(fakeClient(monitors, undefined, majorVersion));

const connectChangingFake = (
  reads: UptimeKumaMonitor[][],
  beforeDelete?: (id: number) => void,
): ConnectedFake => {
  const fake = fakeClient([], beforeDelete);
  let readIndex = 0;
  fake.client.getMonitors = () => {
    const monitors = reads[readIndex++];
    if (monitors === undefined) throw new Error("No monitor-list reply queued");
    return Promise.resolve(monitors);
  };
  return connectClient(fake);
};

export const configuredSite = (): BuiltSite =>
  testBuiltSite({
    name: "Child site",
    scheduledTaskKey: TEST_SCHEDULED_KEY,
    siteUrl: "https://child.example.test/ignored/path",
  });

type AddResult = Awaited<ReturnType<typeof uptimeKumaMonitorService.add>>;

type ChangingAddOutcome = {
  added: AddedMonitor[];
  deleted: number[];
  result: AddResult;
};

type KeylessSiteOutcome<Value> = {
  connections: number;
  result: Value;
};

export const runWithKeylessSite = async <Value>(
  use: (site: BuiltSite) => Promise<Value>,
): Promise<KeylessSiteOutcome<Value>> => {
  using _env = withEnv(kumaEnv);
  let connections = 0;
  using _connect = stub(uptimeKumaClientApi, "connect", () => {
    connections += 1;
    return Promise.reject(new Error("must not connect"));
  });
  const result = await use(testBuiltSite({ scheduledTaskKey: null }));
  return { connections, result };
};

export const runChangingAdd = async (
  reads: UptimeKumaMonitor[][],
  beforeDelete?: (id: number) => void,
): Promise<ChangingAddOutcome> => {
  using _env = withEnv(kumaEnv);
  using fake = connectChangingFake(reads, beforeDelete);
  const result = await uptimeKumaMonitorService.add(configuredSite());
  return { added: fake.added, deleted: fake.deleted, result };
};

type AddRaceCase = {
  addedCount: number;
  addedParent?: number;
  created: boolean;
  deleted: number[];
  monitorId: number;
  name: string;
  reads: UptimeKumaMonitor[][];
};

export const addRaceCases: AddRaceCase[] = [
  {
    addedCount: 2,
    addedParent: 99,
    created: true,
    deleted: [],
    monitorId: 101,
    name: "reuses a group created by a concurrent request",
    reads: [
      [],
      [group(100), group(99)],
      [group(99)],
      [group(99), { ...siteMonitor(99), id: 101 }],
    ],
  },
  {
    addedCount: 2,
    addedParent: 99,
    created: true,
    deleted: [],
    monitorId: 101,
    name: "does not delete a group Kuma no longer returns",
    reads: [
      [],
      [group(99)],
      [group(99)],
      [group(99), { ...siteMonitor(99), id: 101 }],
    ],
  },
  {
    addedCount: 1,
    created: false,
    deleted: [100],
    monitorId: 99,
    name: "removes its duplicate monitor after losing an add race",
    reads: [
      [group()],
      [group()],
      [group(), { ...siteMonitor(), id: 100 }, { ...siteMonitor(), id: 99 }],
    ],
  },
  {
    addedCount: 1,
    created: false,
    deleted: [],
    monitorId: 97,
    name: "reuses a concurrent monitor without deleting either group",
    reads: [
      [],
      [group(100)],
      [
        group(100),
        group(99),
        { ...siteMonitor(99), id: 98 },
        { ...siteMonitor(99), id: 97 },
      ],
    ],
  },
  {
    addedCount: 1,
    created: false,
    deleted: [],
    monitorId: 99,
    name: "keeps its group when another request adds the monitor there",
    reads: [[], [group(100)], [group(100), { ...siteMonitor(100), id: 99 }]],
  },
  {
    addedCount: 1,
    created: false,
    deleted: [],
    monitorId: 101,
    name: "keeps its new group when another request already uses it",
    reads: [
      [],
      [group(99), group(100), { ...siteMonitor(100), id: 101 }],
      [group(99), group(100), { ...siteMonitor(100), id: 101 }],
    ],
  },
  {
    addedCount: 1,
    created: false,
    deleted: [],
    monitorId: 98,
    name: "keeps an owned group that another monitor uses",
    reads: [
      [],
      [group(100)],
      [
        group(100),
        group(99),
        { ...siteMonitor(99), id: 98 },
        {
          ...siteMonitor(100),
          id: 97,
          url: "https://other.example.test/scheduled",
        },
      ],
    ],
  },
  {
    addedCount: 2,
    created: false,
    deleted: [101],
    monitorId: 99,
    name: "removes only its losing monitor",
    reads: [
      [],
      [group(100)],
      [group(100)],
      [
        group(100),
        group(99),
        { ...siteMonitor(99), id: 99 },
        { ...siteMonitor(100), id: 101 },
      ],
    ],
  },
];
