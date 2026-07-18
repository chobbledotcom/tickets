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
