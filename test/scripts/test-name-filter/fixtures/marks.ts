/** Appends one line to the marks file the child test hands the fixture
 * through `TICKETS_TEST_FILTER_MARKS`, so assertions can read what ran
 * without depending on how a reporter prints console output. */
export const mark = (text: string): void => {
  const path = Deno.env.get("TICKETS_TEST_FILTER_MARKS");
  if (path === undefined) {
    throw new Error("TICKETS_TEST_FILTER_MARKS is not set");
  }
  Deno.writeTextFileSync(path, `${text}\n`, { append: true });
};
