import { type CleanupTask, failAfterCleanups } from "../cleanup.ts";

export const startWithFailureCleanup = async <T>(
  start: () => Promise<T>,
  cleanup: CleanupTask,
): Promise<T> => {
  try {
    return await start();
  } catch (error) {
    return await failAfterCleanups(error, [cleanup]);
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
