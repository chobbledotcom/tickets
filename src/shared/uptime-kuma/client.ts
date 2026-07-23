import * as v from "valibot";
import { bearerAuthorization, bearerTokenOrNull } from "#shared/bearer.ts";
import { countExternalSubrequest } from "#shared/subrequest-budget.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import type { UptimeKumaConfig } from "./config.ts";
import {
  createUptimeKumaSocket,
  type UptimeKumaSocket,
  uptimeKumaConnectionError,
} from "./socket.ts";

const SOCKET_TIMEOUT_MS = 10_000;
const MONITOR_LIST_TIMEOUT_MS = 60_000;

type SocketListener = (...args: unknown[]) => void;

export type UptimeKumaClientErrorKind =
  | "monitor_list_timeout"
  | "two_factor"
  | "unsupported_version"
  | "version_timeout";

export class UptimeKumaClientError extends Error {
  constructor(readonly kind: UptimeKumaClientErrorKind) {
    super(kind);
  }
}

export type UptimeKumaMonitorInput = Record<string, unknown>;

export interface UptimeKumaMonitor {
  acceptedStatusCodes: string[];
  active: boolean;
  authorization: string | null;
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

const CustomHeadersSchema = v.record(v.string(), v.string());

type CustomAuthorization = {
  authorization: string | null;
  valid: boolean;
};

const readCustomAuthorization = (
  headers: string | null,
): CustomAuthorization => {
  if (headers === null) return { authorization: null, valid: true };
  try {
    const values = v.parse(CustomHeadersSchema, JSON.parse(headers));
    const entry = Object.entries(values).find(
      ([name]) => name.toLowerCase() === "authorization",
    );
    return {
      authorization: entry === undefined ? null : entry[1],
      valid: true,
    };
  } catch {
    // A malformed custom header belongs to a different, broken monitor.
    return { authorization: null, valid: false };
  }
};

const authorizationFor = (
  headers: string | null,
  authMethod: string | null,
  bearerToken: string | null,
): string | null => {
  const custom = readCustomAuthorization(headers);
  if (!custom.valid) return null;
  if (custom.authorization !== null) {
    const token = bearerTokenOrNull(custom.authorization);
    return token === null ? custom.authorization : bearerAuthorization(token);
  }
  return authMethod === "bearer" && bearerToken !== null
    ? bearerAuthorization(bearerToken)
    : null;
};

const RawMonitorSchema = v.object({
  accepted_statuscodes: v.array(v.string()),
  active: ActiveSchema,
  authMethod: v.nullable(v.string()),
  bearer_token: v.nullable(v.string()),
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
  v.transform(
    ({
      accepted_statuscodes,
      authMethod,
      bearer_token,
      headers,
      ...monitor
    }) => ({
      ...monitor,
      acceptedStatusCodes: accepted_statuscodes,
      authorization: authorizationFor(headers, authMethod, bearer_token),
    }),
  ),
);

const MonitorListSchema = v.record(v.string(), MonitorSchema);
const VersionNumberSchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/),
  v.transform(Number),
  v.safeInteger(),
);
const VersionSchema = v.pipe(
  v.string(),
  v.transform((version) => version.split(".")),
  v.tuple([VersionNumberSchema, VersionNumberSchema]),
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

type EventCapture = {
  cancel: () => void;
  latest: () => unknown;
  received: Promise<void>;
};

type VersionOutcome = { error: unknown; ok: false } | { ok: true };

type VersionCapture = {
  cancel: () => void;
  read: () => Promise<void>;
};

const requireSupportedVersion = ([major, minor]: [number, number]): void => {
  if (major < 2 || (major === 2 && minor < 4)) {
    throw new UptimeKumaClientError("unsupported_version");
  }
};

type TimedEvent = "info" | "monitorList";

const TIMEOUT_ERROR_KINDS: Record<TimedEvent, UptimeKumaClientErrorKind> = {
  info: "version_timeout",
  monitorList: "monitor_list_timeout",
};

const withEventTimeout = async <Value>(
  promise: Promise<Value>,
  event: TimedEvent,
  timeoutMs = SOCKET_TIMEOUT_MS,
): Promise<Value> => {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new UptimeKumaClientError(TIMEOUT_ERROR_KINDS[event]));
  }, timeoutMs);
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
        const parsed = v.safeParse(InfoSchema, value);
        if (!parsed.success) {
          throw new UptimeKumaClientError("unsupported_version");
        }
        const info = parsed.output;
        if (info.version === undefined) {
          socket.once("info", listener);
          return;
        }
        requireSupportedVersion(info.version);
        resolve({ ok: true });
      } catch (error) {
        resolve({ error, ok: false });
      }
    };
    socket.once("info", listener);
  });
  return {
    cancel: () => socket.off("info", listener),
    read: async (): Promise<void> => {
      const outcome = await withEventTimeout(promise, "info");
      if (!outcome.ok) throw outcome.error;
    },
  };
};

const captureEvents = (
  socket: UptimeKumaSocket,
  event: TimedEvent,
  timeoutMs: number,
): EventCapture => {
  let latest: unknown;
  let listener: SocketListener;
  const received = Promise.withResolvers<void>();
  listener = (value) => {
    latest = value;
    received.resolve();
    socket.once(event, listener);
  };
  socket.once(event, listener);
  return {
    cancel: () => {
      socket.off(event, listener);
      received.resolve();
    },
    latest: () => latest,
    received: withEventTimeout(received.promise, event, timeoutMs),
  };
};

const callWithTimeout = (
  socket: UptimeKumaSocket,
  event: string,
  timeoutMs: number,
  ...args: unknown[]
): Promise<unknown> => socket.timeout(timeoutMs).emitWithAck(event, ...args);

const call = (
  socket: UptimeKumaSocket,
  event: string,
  ...args: unknown[]
): Promise<unknown> =>
  callWithTimeout(socket, event, SOCKET_TIMEOUT_MS, ...args);

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
    getMonitors: async (): Promise<UptimeKumaMonitor[]> => {
      const list = captureEvents(
        socket,
        "monitorList",
        MONITOR_LIST_TIMEOUT_MS,
      );
      try {
        const [response] = await Promise.all([
          callWithTimeout(socket, "getMonitorList", MONITOR_LIST_TIMEOUT_MS),
          list.received,
        ]);
        requireOk(response);
        return Object.values(v.parse(MonitorListSchema, list.latest()));
      } finally {
        list.cancel();
      }
    },
    login: async (username, password): Promise<void> => {
      const response = v.parse(
        LoginResponseSchema,
        await call(socket, "login", {
          password,
          token: "",
          username,
        }),
      );
      if ("tokenRequired" in response) {
        throw new UptimeKumaClientError("two_factor");
      }
      if (!response.ok) throw new Error(response.msg);
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
