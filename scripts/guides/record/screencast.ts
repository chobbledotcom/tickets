/**
 * Chrome's own screencast is the footage. It sends one JPEG whenever the page
 * paints, so a character typed into a field and a smooth scroll both arrive as
 * the user would see them. The first frame fixes time zero for the timeline.
 */

import { join } from "@std/path";
import type { CDPSession, Page } from "playwright";
import { withCleanup } from "#scripts/cleanup.ts";
import { frameFileName } from "../frame-name.ts";

const FIRST_FRAME_TIMEOUT_MS = 10_000;

export interface RecordedScreencastFrame {
  atMs: number;
  file: string;
}

export interface Screencast {
  frames: readonly RecordedScreencastFrame[];
  now: () => number;
  stop: () => Promise<void>;
}

const decodableFrame = (data: string): Uint8Array => {
  const bytes = Uint8Array.fromBase64(data);
  if (bytes.length === 0) throw new Error("Chrome sent an empty screen frame");
  return bytes;
};

export const startScreencast = async (
  page: Page,
  outputDir: string,
  viewport: { height: number; width: number },
): Promise<Screencast> => {
  await Deno.mkdir(outputDir, { recursive: true });
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const frames: RecordedScreencastFrame[] = [];
  let startWallClockMs: number | undefined;
  const firstFrame = Promise.withResolvers<void>();
  let writes: Promise<void> = Promise.resolve();

  cdp.on("Page.screencastFrame", (event) => {
    writes = writes.then(async () => {
      const wallMs =
        event.metadata.timestamp === undefined
          ? Date.now()
          : event.metadata.timestamp * 1000;
      startWallClockMs ??= wallMs;
      const file = frameFileName(frames.length + 1, "jpg");
      await Deno.writeFile(join(outputDir, file), decodableFrame(event.data));
      frames.push({
        atMs: Math.max(0, Math.round(wallMs - startWallClockMs)),
        file,
      });
      await cdp.send("Page.screencastFrameAck", {
        sessionId: event.sessionId,
      });
      firstFrame.resolve();
    });
  });

  await cdp.send("Page.startScreencast", {
    everyNthFrame: 1,
    format: "jpeg",
    maxHeight: viewport.height,
    maxWidth: viewport.width,
    quality: 90,
  });

  const timeout = Promise.withResolvers<"timeout">();
  const timeoutId = setTimeout(
    () => timeout.resolve("timeout"),
    FIRST_FRAME_TIMEOUT_MS,
  );
  const first = await Promise.race([
    firstFrame.promise.then(() => "frame" as const),
    timeout.promise,
  ]);
  clearTimeout(timeoutId);
  if (first === "timeout") {
    await cdp.send("Page.stopScreencast").catch(() => {
      // The stream may already be gone after the first-frame timeout.
    });
    await cdp.detach().catch(() => {
      // The session may already be closed with the browser.
    });
    throw new Error("Chrome sent no screen frame within 10 seconds");
  }

  const stop = async (): Promise<void> => {
    await cdp.send("Page.stopScreencast");
    await writes;
    await cdp.detach();
  };

  return {
    frames,
    now: () => {
      if (startWallClockMs === undefined) {
        throw new Error("The screencast has not started");
      }
      return Math.max(0, Math.round(Date.now() - startWallClockMs));
    },
    stop,
  };
};

/** Run a recording and always stop Chrome's stream, even when an action throws. */
export const withScreencast = async <T>(
  target: {
    outputDir: string;
    page: Page;
    viewport: { height: number; width: number };
  },
  run: (screencast: Screencast) => Promise<T>,
): Promise<T> => {
  const screencast = await startScreencast(
    target.page,
    target.outputDir,
    target.viewport,
  );
  return withCleanup(() => run(screencast), [screencast.stop]);
};
