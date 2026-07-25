import { parseWorkerCount } from "#scripts/workers.ts";

export const MAX_SPEC_WORKERS = 4;

export const specWorkerCount = (
  selectedCases: number,
  configured: string | undefined,
  hardwareConcurrency: number,
): number => {
  if (selectedCases < 2) return 0;
  const available = parseWorkerCount(
    configured,
    Math.max(1, hardwareConcurrency),
  );
  return Math.min(selectedCases, available, MAX_SPEC_WORKERS);
};
