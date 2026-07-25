/**
 * Run the heavy checks under the cross-worktree lock, then release it before
 * the optional push prompt. CI jobs are already isolated and skip the lock.
 */
export const runChecksBeforePush = async (
  ci: boolean,
  checks: () => Promise<void>,
  push: () => Promise<void>,
  lock: (task: () => Promise<void>) => Promise<void>,
): Promise<void> => {
  if (ci) await checks();
  else await lock(checks);
  await push();
};
