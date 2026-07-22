import type { SnapshotProgress } from "#scripts/database-snapshot-lib.ts";
import { formatMs } from "#shared/limits.ts";

const CLEAR_LINE = "\r\x1b[2K";
const UPDATE_INTERVAL_MS = 1_000;

export interface SnapshotOutputOptions {
  terminal: boolean;
  write: (text: string) => void;
}

export interface SnapshotProgressOutput {
  report(message: SnapshotProgress): void;
  stop(): void;
}

interface RenderedProgress {
  message: SnapshotProgress;
  renderedLine: string;
  startedAt: number;
}

interface ActiveProgress {
  progress: RenderedProgress;
  timer: number;
}

export const createSnapshotProgressOutput = ({
  terminal,
  write,
}: SnapshotOutputOptions): SnapshotProgressOutput => {
  if (!terminal) {
    return {
      report: (message) => write(`${message}\n`),
      stop: () => {},
    };
  }

  let active: ActiveProgress | null = null;

  const render = (progress: RenderedProgress): void => {
    const elapsed = Date.now() - progress.startedAt;
    const line =
      elapsed < UPDATE_INTERVAL_MS
        ? progress.message
        : `${progress.message} (${formatMs(elapsed)})`;
    if (line === progress.renderedLine) return;
    progress.renderedLine = line;
    write(`${CLEAR_LINE}${line}`);
  };

  const finish = (progress: ActiveProgress): void => {
    clearInterval(progress.timer);
    render(progress.progress);
    write("\n");
  };

  return {
    report: (message) => {
      if (active !== null) finish(active);
      const progress = {
        message,
        renderedLine: "",
        startedAt: Date.now(),
      };
      render(progress);
      active = {
        progress,
        timer: setInterval(() => render(progress), UPDATE_INTERVAL_MS),
      };
    },
    stop: () => {
      if (active === null) return;
      finish(active);
      active = null;
    },
  };
};
