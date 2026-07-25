/** Read a worker count from an environment value, falling back when invalid. */
export const parseWorkerCount = (
  value: string | undefined,
  fallback: number,
): number => {
  const jobs = Number(value);
  return Number.isInteger(jobs) && jobs > 0 ? jobs : fallback;
};
