/** One job at a time, in the order the jobs were asked for. */
export type SerialQueue = <T>(run: () => Promise<T>) => Promise<T>;

/**
 * Make a queue: each job it takes waits for the job before it to settle. Two
 * jobs that share one resource then land one at a time. A failed job must not
 * stop the queue behind it, so its outcome is dropped.
 */
export const serialQueue = (): SerialQueue => {
  let tail: Promise<unknown> = Promise.resolve();
  return (run) => {
    const result = tail.catch(() => undefined).then(run);
    tail = result;
    return result;
  };
};
