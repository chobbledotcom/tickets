import { UptimeKumaError, type UptimeKumaErrorKind } from "./error.ts";
import {
  SOCKET_TIMEOUT_MS,
  type SocketListener,
  type UptimeKumaSocket,
} from "./socket.ts";

/**
 * Timing out socket event captures and request acknowledgements.
 *
 * The socket wrapper emits named events (`info`, `monitorList`) and returns
 * ack values from `emitWithAck`. Each call that waits for a Kuma reply needs
 * its own timeout so a silent Kuma server cannot hang the maintenance tab.
 */

const MONITOR_LIST_TIMEOUT_MS = 60_000;

type TimedEvent = "info" | "monitorList";

const TIMEOUT_ERROR_KINDS: Record<TimedEvent, UptimeKumaErrorKind> = {
  info: "version_timeout",
  monitorList: "monitor_list_timeout",
};

export const withEventTimeout = async <Value>(
  promise: Promise<Value>,
  event: TimedEvent,
  timeoutMs = SOCKET_TIMEOUT_MS,
): Promise<Value> => {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new UptimeKumaError(TIMEOUT_ERROR_KINDS[event])),
    timeoutMs,
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
};

type EventCapture = {
  cancel: () => void;
  latest: () => unknown;
  received: Promise<void>;
};

/**
 * Captures every push of `event` until `cancel` or `received` resolves. Kuma
 * can send the same event more than once (an early stale list followed by the
 * real one), so the capture stays open and keeps the newest value.
 */
export const captureEvents = (
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

export const callWithTimeout = (
  socket: UptimeKumaSocket,
  event: string,
  timeoutMs: number,
  ...args: unknown[]
): Promise<unknown> => socket.timeout(timeoutMs).emitWithAck(event, ...args);

export const call = (
  socket: UptimeKumaSocket,
  event: string,
  ...args: unknown[]
): Promise<unknown> =>
  callWithTimeout(socket, event, SOCKET_TIMEOUT_MS, ...args);

export const callMonitorList = (socket: UptimeKumaSocket): Promise<unknown> =>
  callWithTimeout(socket, "getMonitorList", MONITOR_LIST_TIMEOUT_MS);

export const monitorListCapture = (socket: UptimeKumaSocket): EventCapture =>
  captureEvents(socket, "monitorList", MONITOR_LIST_TIMEOUT_MS);
