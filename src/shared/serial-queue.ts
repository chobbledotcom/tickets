/** One job at a time, in the order the jobs were asked for. */
export type SerialQueue = <T>(run: () => Promise<T>) => Promise<T>;

/**
 * Make a queue: each job it takes waits for the job before it to settle. Two
 * jobs that share one resource then land one at a time.
 */
export const serialQueue = (): SerialQueue => {
  let tail: Promise<unknown> = Promise.resolve();
  return (run) => {
    const previous = tail;
    const result = (async () => {
      try {
        await previous;
      } catch {
        // A failed job must not stop the queue behind it.
      }
      return run();
    })();
    tail = result;
    return result;
  };
};
