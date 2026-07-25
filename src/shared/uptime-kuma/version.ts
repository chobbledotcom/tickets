import * as v from "valibot";
import { UptimeKumaError } from "./error.ts";
import { withEventTimeout } from "./event-capture.ts";
import type { SocketListener, UptimeKumaSocket } from "./socket.ts";

/**
 * Reading Uptime Kuma's post-login version event and checking the server is
 * supported (2.4 or later).
 *
 * Kuma sends an `info` event carrying the server version. The first `info`
 * frame after login is version-less, so the capture stays open until a
 * version-bearing one arrives.
 */

export const VersionNumberSchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/),
  v.transform(Number),
  v.safeInteger(),
);

export const VersionSchema = v.pipe(
  v.string(),
  v.transform((version) => version.split(".")),
  v.tuple([VersionNumberSchema, VersionNumberSchema]),
);

const InfoSchema = v.object({ version: v.optional(VersionSchema) });

export const requireSupportedVersion = ([major, minor]: [
  number,
  number,
]): void => {
  if (major < 2 || (major === 2 && minor < 4)) {
    throw new UptimeKumaError("unsupported_version");
  }
};

type VersionOutcome = { error: unknown; ok: false } | { ok: true };

type VersionCapture = {
  cancel: () => void;
  read: () => Promise<void>;
};

/**
 * Captures a `info` event from Kuma, staying open through the first
 * version-less frame until the version-bearing one arrives, then checks the
 * server is supported. Resolves on a supported version or throws once the
 * versioned `info` event has been seen.
 */
export const captureVersion = (socket: UptimeKumaSocket): VersionCapture => {
  let listener: SocketListener;
  const promise = new Promise<VersionOutcome>((resolve) => {
    listener = (value) => {
      try {
        const parsed = v.safeParse(InfoSchema, value);
        if (!parsed.success) throw new UptimeKumaError("unsupported_version");
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
