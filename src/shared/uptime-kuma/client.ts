import { countExternalSubrequest } from "#shared/subrequest-budget.ts";
import type { UptimeKumaConfig } from "./config.ts";
import { UptimeKumaError } from "./error.ts";
import { call, callMonitorList, monitorListCapture } from "./event-capture.ts";
import {
  AddResponseSchema,
  LoginResponseSchema,
  MonitorListSchema,
  parseKumaResponse,
  requireOk,
  type UptimeKumaMonitor,
  type UptimeKumaMonitorInput,
} from "./schemas.ts";
import {
  createUptimeKumaSocket,
  type UptimeKumaSocket,
  uptimeKumaConnectionError,
} from "./socket.ts";
import { captureVersion } from "./version.ts";

export type { UptimeKumaMonitor, UptimeKumaMonitorInput };

export interface UptimeKumaClient {
  addMonitor(monitor: UptimeKumaMonitorInput): Promise<number>;
  deleteMonitor(id: number): Promise<void>;
  disconnect(): void;
  getMonitors(): Promise<UptimeKumaMonitor[]>;
  login(username: string, password: string): Promise<void>;
}

type SocketListener = (...args: unknown[]) => void;

const SOCKET_TIMEOUT_MS = 10_000;

export const createUptimeKumaClient = (
  socket: UptimeKumaSocket,
): UptimeKumaClient => {
  const version = captureVersion(socket);
  return {
    addMonitor: async (monitor): Promise<number> => {
      const response = parseKumaResponse(
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
    getMonitors: async (): Promise<UptimeKumaMonitor[]> => {
      const list = monitorListCapture(socket);
      try {
        const [response] = await Promise.all([
          callMonitorList(socket),
          list.received,
        ]);
        requireOk(response);
        return Object.values(
          parseKumaResponse(MonitorListSchema, list.latest()),
        );
      } finally {
        list.cancel();
      }
    },
    login: async (username, password): Promise<void> => {
      const response = parseKumaResponse(
        LoginResponseSchema,
        await call(socket, "login", {
          password,
          token: "",
          username,
        }),
      );
      if ("tokenRequired" in response) {
        throw new UptimeKumaError("two_factor");
      }
      if (!response.ok) {
        if (response.msgi18n === true) {
          throw new UptimeKumaError("incorrect_credentials");
        }
        throw new Error(response.msg);
      }
      await version.read();
    },
  };
};

const socketPath = (url: URL): string => {
  const basePath = url.pathname === "/" ? "" : url.pathname;
  return `${basePath}/socket.io`;
};

const socketUrl = (url: URL): string => {
  const socket = new URL(url.origin);
  socket.protocol = url.protocol === "https:" ? "wss" : "ws";
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
