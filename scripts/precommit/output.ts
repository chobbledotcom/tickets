/** True when a line starts an ERRORS or FAILURES section or is a summary line */
const isSectionStart = (line: string): boolean =>
  /^ (ERRORS|FAILURES)\s*$/.test(line) ||
  /^::error/.test(line) ||
  /^Coverage failed/.test(line) ||
  /^(FAILED|Failed tests:|fail\b)/.test(line) ||
  /^(Line|Branch) coverage is not 100%:/.test(line) ||
  /^Test quality rules:/.test(line) ||
  /^(FAILED|ok)\s*\|/.test(line);

/** True when a line contains a failure or error keyword */
const isErrorLine = (line: string): boolean =>
  /^::error/.test(line) ||
  /^Coverage failed/.test(line) ||
  /^(FAILED|fail\b|error:|Error:|AssertionError)/.test(line) ||
  /coverage is not 100%/.test(line);

/** Collect lines from the first section-start onward */
const collectFromSections = (lines: string[]): string[] => {
  const output: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (isSectionStart(line)) capturing = true;
    if (capturing) output.push(line);
  }
  return output;
};

/** Extract only failures and errors from deno test output */
export const filterTestOutput = (stdout: string, stderr: string): string => {
  const lines = `${stdout}\n${stderr}`.split("\n");
  const output = collectFromSections(lines);
  if (output.length === 0) return lines.filter(isErrorLine).join("\n").trim();
  return output.join("\n").trim();
};

export const testProgressFromLine = (line: string): string | undefined => {
  if (line.trim() === "Running tests...") return "(starting tests)";

  const numbered = line.match(/^(?:ok|fail)\s+\[[^\]]+\]\s+(\d+)\/(\d+)\b/);
  if (numbered?.[1] && numbered[2]) return `(${numbered[1]}/${numbered[2]})`;

  const done = line.match(/^(?:ok|fail)\s+\[\s*(\d+)\s+done\]/);
  if (done?.[1]) return `(${done[1]} done)`;

  if (line.trim() === "Checking coverage...") return "(checking coverage)";
  return undefined;
};
