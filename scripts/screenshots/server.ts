import {
  type CleanupTask,
  failAfterCleanups,
  runCleanups,
} from "#scripts/cleanup.ts";

export interface StartupCleanup {
  add: (cleanup: CleanupTask) => void;
  run: () => Promise<void>;
}

export const startWithFailureCleanup = async <T>(
  start: (cleanup: StartupCleanup) => Promise<T>,
): Promise<T> => {
  const cleanups: CleanupTask[] = [];
  const cleanup: StartupCleanup = {
    add: (task) => cleanups.unshift(task),
    run: () => runCleanups(cleanups),
  };
  try {
    return await start(cleanup);
  } catch (error) {
    return await failAfterCleanups(error, cleanups);
  }
};

export const waitForHealthy = async (
  request: () => Promise<Response>,
  wait: () => Promise<void>,
  beforeDeadline: () => boolean,
): Promise<boolean> => {
  while (beforeDeadline()) {
    let response: Response;
    try {
      response = await request();
    } catch {
      await wait();
      continue;
    }
    const healthy = response.ok;
    await response.body?.cancel();
    if (healthy) return true;
    await wait();
  }
  return false;
};
