/** Whether `action` completes without throwing — the contract behind every
 * format-and-validity check that answers only "usable or not": a thrown
 * answer is the check's documented "no". */
export const succeeds = (action: () => unknown): boolean => {
  try {
    action();
    return true;
  } catch {
    return false;
  }
};
