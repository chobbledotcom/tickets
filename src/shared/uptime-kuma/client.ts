import * as v from "valibot";
import { countExternalSubrequest } from "#shared/subrequest-budget.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import type { UptimeKumaConfig } from "./config.ts";

const SOCKET_TIMEOUT_MS = 10_000;

type SocketListener = (...args: unknown[]) => void;

export interface UptimeKumaSocket {
  connect(): unknown;
  disconnect(): unknown;
  emitWithAck(event: string, ...args: unknown[]): Promise<unknown>;
  off(event: string, listener: SocketListener): unknown;
  once(event: string, listener: SocketListener): unknown;
  timeout(milliseconds: number): UptimeKumaSocket;
}

export type UptimeKumaMonitorInput = Record<string, unknown>;

export interface UptimeKumaMonitor {
  active: boolean;
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
  getMonitors(): Promise<UptimeKumaMonitor[]>;
  login(username: string, password: string): Promise<void>;
}

const ActiveSchema = v.pipe(
  v.union([v.boolean(), v.literal(0), v.literal(1)]),
  v.transform((value) => value === true || value === 1),
);

const MonitorSchema = v.object({
  active: ActiveSchema,
  id: integerAtLeast(1),
  interval: integerAtLeast(1),
  method: v.string(),
  name: v.string(),
  parent: v.nullable(integerAtLeast(1)),
  type: v.string(),
  url: v.nullable(v.string()),
});

const MonitorListSchema = v.record(v.string(), MonitorSchema);
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

const responseError = (value: unknown): Error =>
  value instanceof Error ? value : new Error("Uptime Kuma connection failed.");

const requireOk = (value: unknown): void => {
  const response = v.parse(BasicResponseSchema, value);
  if (!response.ok) throw new Error(response.msg);
};

type EventWaiter = {
  cancel: () => void;
  promise: Promise<unknown>;
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
): UptimeKumaClient => ({
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
    socket.disconnect();
  },
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
});

const socketPath = (url: URL): string => {
  const basePath = url.pathname === "/" ? "" : url.pathname;
  return `${basePath}/socket.io`;
};

export const uptimeKumaSocketFactory = {
  create: async (config: UptimeKumaConfig): Promise<UptimeKumaSocket> => {
    countExternalSubrequest("Uptime Kuma socket connection");
    const { io } = await import("socket.io-client");
    const url = new URL(config.url);
    return io(url.origin, {
      autoConnect: false,
      path: socketPath(url),
      reconnection: false,
      timeout: SOCKET_TIMEOUT_MS,
      transports: ["websocket"],
    });
  },
};

const connect = async (config: UptimeKumaConfig): Promise<UptimeKumaClient> => {
  const socket = await uptimeKumaSocketFactory.create(config);
  try {
    await new Promise<void>((resolve, reject) => {
      const connected: SocketListener = () => {
        socket.off("connect_error", failed);
        resolve();
      };
      const failed: SocketListener = (error) => {
        socket.off("connect", connected);
        reject(responseError(error));
      };
      socket.once("connect", connected);
      socket.once("connect_error", failed);
      socket.connect();
    });
    return createUptimeKumaClient(socket);
  } catch (error) {
    socket.disconnect();
    throw error;
  }
};

export const uptimeKumaClientApi = { connect };
