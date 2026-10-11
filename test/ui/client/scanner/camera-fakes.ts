/// <reference lib="dom" />

import { el, type ScannerHarness } from "./fixture.ts";

export type CameraFakes = ReturnType<typeof cameraFakes>;

/** Drain the promise hops a stubbed fetch and a settled scan need. */
export const drain = async (): Promise<void> => {
  for (let hop = 0; hop < 50; hop++) await Promise.resolve();
};

/** Press the start button and let the camera flow settle. */
export const start = async (h: ScannerHarness): Promise<void> => {
  el(h.document, "scanner-start").click();
  await drain();
};

/** Decode the first ticket and let the clock reach the scan it triggers. */
export const scanFirst = async (
  fakes: CameraFakes,
  code: string,
): Promise<void> => {
  fakes.decode({ data: code });
  fakes.advance(1000);
  await drain();
};

/** Decode one code and let the clock run to the scan it triggers. */
export const scanNext = async (
  fakes: CameraFakes,
  code: string,
  ms: number,
): Promise<void> => {
  fakes.decode({ data: code });
  fakes.advance(ms);
  await drain();
};

/** Let the clock run on without a new code and drain the hops. */
export const idle = async (fakes: CameraFakes, ms: number): Promise<void> => {
  fakes.advance(ms);
  await drain();
};

/** The fakes one camera test runs against: a clock the test moves forward,
 * the timer queue the loop schedules onto, a canvas context recording its
 * calls, a decoder answering the test's codes, and a camera that opens on
 * demand. The bundle reads these globals at call time, so installing them
 * after the page loads is enough. Disposing restores every one of them. */
export const cameraFakes = (h: ScannerHarness) => {
  const video = el(h.document, "scanner-video") as unknown as Record<
    string,
    unknown
  >;
  let now = 1_000;
  let nextId = 1;
  let nextCode: { data: string } | null = null;
  const pending = new Map<number, { at: number; fn: () => void }>();

  const fakes = {
    /** Move the clock forward, running every timer it reaches, in order. */
    advance(ms: number): void {
      now += ms;
      const due = [...pending.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        if (!pending.has(id)) continue;
        pending.delete(id);
        timer.fn();
      }
    },
    cameraCalls: [] as unknown[][],
    contextTypes: [] as string[],

    /** Answer the next decode with a code, or with nothing. */
    decode(code: { data: string } | null): void {
      nextCode = code;
    },
    decodeCalls: 0,
    drawn: [] as unknown[][],
    played: 0,
    reads: [] as unknown[][],

    /** Set the frame source's readiness and size, as a real camera gives
     * them. */
    ready(state: number): void {
      for (const [key, value] of [
        ["readyState", state],
        ["videoWidth", 640],
        ["videoHeight", 480],
        ["HAVE_ENOUGH_DATA", 4],
      ] as const) {
        Object.defineProperty(video, key, { configurable: true, value });
      }
    },

    /** The smallest wait among the scheduled timers, or null when none is
     * pending. */
    scheduledDelay(): number | null {
      let shortest: number | null = null;
      for (const timer of pending.values()) {
        const delay = timer.at - now;
        if (shortest === null || delay < shortest) shortest = delay;
      }
      return shortest;
    },
    stream: null as unknown,
    tracks: [
      {
        stop(): void {
          this.stopped = true;
        },
        stopped: false,
      },
      {
        stop(): void {
          this.stopped = true;
        },
        stopped: false,
      },
    ],
  };

  const setTimeoutFake = (fn: () => void, ms: number): number => {
    const id = nextId++;
    pending.set(id, { at: now + ms, fn });
    return id;
  };
  const clearTimeoutFake = (id: number): void => {
    pending.delete(id);
  };
  const originalNow = Date.now;
  const jsqr = (): { data: string } | null => {
    fakes.decodeCalls += 1;
    return nextCode;
  };
  const getContext = (type: string): unknown => {
    fakes.contextTypes.push(type);
    return {
      drawImage: (...args: unknown[]) => {
        fakes.drawn.push(args);
      },
      getImageData: (...args: unknown[]) => {
        fakes.reads.push(args);
        return { data: new Uint8ClampedArray(4), height: 1, width: 1 };
      },
    };
  };
  const play = (): Promise<void> => {
    fakes.played += 1;
    return Promise.resolve();
  };

  const globals = globalThis as Record<string, unknown>;
  const canvas = h.window.HTMLCanvasElement.prototype as unknown as {
    getContext: unknown;
  };
  const saved = {
    clearTimeout: globals.clearTimeout,
    getContext: canvas.getContext,
    now: originalNow,
    play: video.play,
    setTimeout: globals.setTimeout,
  };
  const dispose = (): void => {
    // happy-dom pages carry none of the camera globals, so removing them
    // restores the page; the timer and clock globals always exist.
    canvas.getContext = saved.getContext;
    video.play = saved.play as HTMLVideoElement["play"];
    globals.setTimeout = saved.setTimeout;
    globals.clearTimeout = saved.clearTimeout;
    Date.now = saved.now;
    delete (navigator as unknown as Record<string, unknown>).mediaDevices;
    delete (video as unknown as Record<string, unknown>).srcObject;
    delete globals.__scannerJsqr;
  };

  globals.setTimeout = setTimeoutFake as unknown as typeof setTimeout;
  globals.clearTimeout = clearTimeoutFake as unknown as typeof clearTimeout;
  Date.now = (): number => now;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    get: () => ({
      getUserMedia: (...args: unknown[]) => {
        fakes.cameraCalls.push(args);
        return Promise.resolve({ getTracks: () => fakes.tracks });
      },
    }),
  });
  globals.__scannerJsqr = jsqr;
  canvas.getContext = getContext;
  video.play = play;
  // The fake stream is not happy-dom's MediaStream, so the validated setter
  // would refuse it; the page only ever reads it back.
  Object.defineProperty(video, "srcObject", {
    configurable: true,
    get: () => fakes.stream,
    set: (value: unknown) => {
      fakes.stream = value;
    },
  });

  const disposable = fakes as typeof fakes & { [Symbol.dispose]: () => void };
  disposable[Symbol.dispose] = dispose;
  return disposable;
};
