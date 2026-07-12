import nodeProcess from "node:process";

const beforeTimeout = async (
  status: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> => {
  // Typed via ReturnType so it works on both the pinned runtime (number) and
  // newer Deno, where node types make setTimeout return a Timeout object.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const delayed = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([status.then(() => true), delayed]);
  } finally {
    clearTimeout(timeout);
  }
};

export const processExists = (pid: number): boolean => {
  try {
    nodeProcess.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const stopProcessNow = (process: Deno.ChildProcess): void => {
  try {
    process.kill("SIGKILL");
  } catch {
    // It may already have exited.
  }
};

export const stopProcess = async (
  process: Deno.ChildProcess,
  timeoutMs: number,
  afterStop: () => Promise<void> = () => Promise.resolve(),
): Promise<void> => {
  process.ref();
  const status = process.status;
  try {
    try {
      process.kill();
    } catch {
      // It may already have exited.
    }
    if (!(await beforeTimeout(status, timeoutMs))) {
      stopProcessNow(process);
      await status.catch(() => {});
    }
  } finally {
    await afterStop();
  }
};
