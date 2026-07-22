import * as v from "valibot";
import { countExternalSubrequest } from "#shared/subrequest-budget.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import type { UptimeKumaConfig } from "./config.ts";
import {
  createUptimeKumaSocket,
  type UptimeKumaSocket,
  uptimeKumaConnectionError,
} from "./socket.ts";

const SOCKET_TIMEOUT_MS = 10_000;

type SocketListener = (...args: unknown[]) => void;

export type UptimeKumaMonitorInput = Record<string, unknown>;

export interface UptimeKumaMonitor {
  acceptedStatusCodes: string[];
  active: boolean;
  headers: string | null;
  id: number;
  interval: number;
  method: string;
  name: string;
  parent: number | null;
  type: string;
  url: string | null;
}

export interface UptimeKumaClient {
  addMonitor(monitor: UptimeKumaMonitorInput): Promise<number>;
  deleteMonitor(id: number): Promise<void>;
  disconnect(): void;
  getMajorVersion(): Promise<number>;
  getMonitors(): Promise<UptimeKumaMonitor[]>;
  login(username: string, password: string): Promise<void>;
}

const ActiveSchema = v.pipe(
  v.union([v.boolean(), v.literal(0), v.literal(1)]),
  v.transform((value) => value === true || value === 1),
);

const RawMonitorSchema = v.object({
  accepted_statuscodes: v.array(v.string()),
  active: ActiveSchema,
  headers: v.nullable(v.string()),
  id: integerAtLeast(1),
  interval: integerAtLeast(1),
  method: v.string(),
  name: v.string(),
  parent: v.nullable(integerAtLeast(1)),
  type: v.string(),
  url: v.nullable(v.string()),
});
const MonitorSchema = v.pipe(
  RawMonitorSchema,
  v.transform(({ accepted_statuscodes, ...monitor }) => ({
    ...monitor,
    acceptedStatusCodes: accepted_statuscodes,
  })),
);

const MonitorListSchema = v.record(v.string(), MonitorSchema);
const VersionSchema = v.pipe(
  v.string(),
  v.regex(/^[1-9]\d*(?:\.|$)/),
  v.transform((version) => Number(version.split(".")[0])),
  v.safeInteger(),
);
const InfoSchema = v.object({ version: v.optional(VersionSchema) });
const FailedResponseSchema = v.object({
  msg: v.string(),
  ok: v.literal(false),
});
const OkResponseSchema = v.object({ ok: v.literal(true) });
const BasicResponseSchema = v.union([OkResponseSchema, FailedResponseSchema]);
const LoginResponseSchema = v.union([
  BasicResponseSchema,
  v.object({ tokenRequired: v.literal(true) }),
]);
const AddResponseSchema = v.union([
  v.object({ monitorID: integerAtLeast(1), ok: v.literal(true) }),
  FailedResponseSchema,
]);

const requireOk = (value: unknown): void => {
  const response = v.parse(BasicResponseSchema, value);
  if (!response.ok) throw new Error(response.msg);
};

type EventWaiter = {
  cancel: () => void;
  promise: Promise<unknown>;
};

type VersionOutcome =
  | { error: unknown; ok: false }
  | { majorVersion: number; ok: true };

type VersionCapture = {
  cancel: () => void;
  read: () => Promise<number>;
};

const withEventTimeout = async <Value>(
  promise: Promise<Value>,
  event: string,
): Promise<Value> => {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new Error(`Uptime Kuma did not send ${event}.`));
  }, SOCKET_TIMEOUT_MS);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
};

const captureVersion = (socket: UptimeKumaSocket): VersionCapture => {
  let listener: SocketListener;
  const promise = new Promise<VersionOutcome>((resolve) => {
    listener = (value) => {
      try {
        const info = v.parse(InfoSchema, value);
        if (info.version === undefined) {
          socket.once("info", listener);
          return;
        }
        resolve({ majorVersion: info.version, ok: true });
      } catch (error) {
        resolve({ error, ok: false });
      }
    };
    socket.once("info", listener);
  });
  return {
    cancel: () => socket.off("info", listener),
    read: async (): Promise<number> => {
      const outcome = await withEventTimeout(promise, "info");
      if (!outcome.ok) throw outcome.error;
      return outcome.majorVersion;
    },
  };
};

const waitForEvent = (socket: UptimeKumaSocket, event: string): EventWaiter => {
  let timer: number;
  let listener: SocketListener;
  const promise = new Promise<unknown>((resolve, reject) => {
    listener = resolve;
    socket.once(event, listener);
    timer = setTimeout(() => {
      reject(new Error(`Uptime Kuma did not send ${event}.`));
    }, SOCKET_TIMEOUT_MS);
  });
  return {
    cancel: () => {
      clearTimeout(timer);
      socket.off(event, listener);
    },
    promise,
  };
};

const call = (
  socket: UptimeKumaSocket,
  event: string,
  ...args: unknown[]
): Promise<unknown> =>
  socket.timeout(SOCKET_TIMEOUT_MS).emitWithAck(event, ...args);

export const createUptimeKumaClient = (
  socket: UptimeKumaSocket,
): UptimeKumaClient => {
  const version = captureVersion(socket);
  return {
    addMonitor: async (monitor): Promise<number> => {
      const response = v.parse(
        AddResponseSchema,
        await call(socket, "add", monitor),
      );
      if (!response.ok) throw new Error(response.msg);
      return response.monitorID;
    },
    deleteMonitor: async (id): Promise<void> => {
      requireOk(await call(socket, "deleteMonitor", id));
    },
    disconnect: (): void => {
      version.cancel();
      socket.disconnect();
    },
    getMajorVersion: (): Promise<number> => version.read(),
    getMonitors: async (): Promise<UptimeKumaMonitor[]> => {
      const list = waitForEvent(socket, "monitorList");
      try {
        const [response, monitorList] = await Promise.all([
          call(socket, "getMonitorList"),
          list.promise,
        ]);
        requireOk(response);
        return Object.values(v.parse(MonitorListSchema, monitorList));
      } finally {
        list.cancel();
      }
    },
    login: async (username, password): Promise<void> => {
      const response = v.parse(
        LoginResponseSchema,
        await call(socket, "login", { password, token: "", username }),
      );
      if ("tokenRequired" in response) {
        throw new Error("Uptime Kuma two-factor login is not supported.");
      }
      if (!response.ok) throw new Error(response.msg);
    },
  };
};

const socketPath = (url: URL): string => {
  const basePath = url.pathname === "/" ? "" : url.pathname;
  return `${basePath}/socket.io`;
};

const socketUrl = (url: URL): string => {
  const socket = new URL(url.origin);
  socket.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  socket.pathname = `${socketPath(url)}/`;
  socket.searchParams.set("EIO", "4");
  socket.searchParams.set("transport", "websocket");
  return socket.href;
};

export const uptimeKumaSocketFactory = {
  create: async (config: UptimeKumaConfig): Promise<UptimeKumaSocket> => {
    countExternalSubrequest("Uptime Kuma socket connection");
    const url = new URL(config.url);
    return createUptimeKumaSocket(socketUrl(url), SOCKET_TIMEOUT_MS);
  },
};

const connect = async (config: UptimeKumaConfig): Promise<UptimeKumaClient> => {
  const socket = await uptimeKumaSocketFactory.create(config);
  const client = createUptimeKumaClient(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      const connected: SocketListener = () => {
        socket.off("connect_error", failed);
        resolve();
      };
      const failed: SocketListener = (error) => {
        socket.off("connect", connected);
        reject(uptimeKumaConnectionError(error));
      };
      socket.once("connect", connected);
      socket.once("connect_error", failed);
      socket.connect();
    });
    return client;
  } catch (error) {
    client.disconnect();
    throw error;
  }
};

export const uptimeKumaClientApi = { connect };
