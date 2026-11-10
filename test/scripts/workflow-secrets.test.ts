import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { filter, flatMap, map } from "#fp";

const WORKFLOW_DIR = ".github/workflows";
const ACTION_DIR = ".github/actions";
const RESOLVE_ACTION_PATH = `${ACTION_DIR}/resolve-site-credentials/action.yml`;

/** A run input whose name says it carries a credential. */
const CREDENTIAL_INPUT = /inputs\.\w*(key|token|secret|password)\w*/gi;
/** A value the person who starts or triggers a run controls. */
const CALLER_VALUE = /\$\{\{[^}]*\b(inputs|github\.event|github\.head_ref)\b/;
/** The first line of a step's script. */
const RUN_KEY = /^(\s*(?:- )?)run:(.*)$/;

type YamlFile = { path: string; text: string };

const yamlFile = (path: string): YamlFile => ({
  path,
  text: Deno.readTextFileSync(path),
});

const workflowFiles = (): YamlFile[] =>
  [...Deno.readDirSync(WORKFLOW_DIR)]
    .map((entry) => yamlFile(`${WORKFLOW_DIR}/${entry.name}`))
    .sort((a, b) => a.path.localeCompare(b.path));

const actionFiles = (): YamlFile[] =>
  [...Deno.readDirSync(ACTION_DIR)]
    .map((entry) => yamlFile(`${ACTION_DIR}/${entry.name}/action.yml`))
    .sort((a, b) => a.path.localeCompare(b.path));

const isComment = (line: string): boolean => line.trim().startsWith("#");

const codeLines = (text: string): string[] =>
  text.split("\n").filter((line) => !isComment(line));

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

type RunScan = { scriptIndent: number | null; scriptLines: string[] };

/** Collects the lines of every `run:` script: the text on the key's own line,
 * and the deeper-indented block below it. */
const collectRunLine = (scan: RunScan, line: string): RunScan => {
  const runKey = RUN_KEY.exec(line);
  if (runKey) {
    const [, prefix, firstLine] = runKey;
    scan.scriptIndent = prefix!.length;
    scan.scriptLines.push(firstLine!);
    return scan;
  }
  if (scan.scriptIndent === null) return scan;
  if (line.trim() !== "" && indentOf(line) <= scan.scriptIndent) {
    scan.scriptIndent = null;
    return scan;
  }
  scan.scriptLines.push(line);
  return scan;
};

const runScriptLines = (text: string): string[] =>
  codeLines(text).reduce<RunScan>(collectRunLine, {
    scriptIndent: null,
    scriptLines: [],
  }).scriptLines;

/** Names each script line that expands a caller's value, as "path: line". */
const callerValuesInScripts = ({ path, text }: YamlFile): string[] =>
  runScriptLines(text)
    .filter((line) => CALLER_VALUE.test(line))
    .map((line) => `${path}: ${line.trim()}`);

const credentialInputs = ({ path, text }: YamlFile): string[] =>
  [...codeLines(text).join("\n").matchAll(CREDENTIAL_INPUT)].map(
    ([name]) => `${path}: ${name}`,
  );

/** The text of each job, which starts at a key two spaces under `jobs:`. */
const jobBlocks = (text: string): string[] => {
  const jobs = codeLines(text)
    .join("\n")
    .split(/^jobs:\n/m)[1];
  if (jobs === undefined) throw new Error("The workflow declares no jobs");
  return jobs.split(/^ {2}(?=[\w-]+:)/m).filter((block) => block !== "");
};

const readsSecrets = (job: string): boolean => /\bsecrets\.[A-Z_]+/.test(job);

const hasEnvironment = (job: string): boolean =>
  /^ {4}environment: \S+/m.test(job);

const jobName = (job: string): string => job.slice(0, job.indexOf(":"));

/** Names each job that reads a secret outside an environment. */
const secretJobsWithoutEnvironment = ({ path, text }: YamlFile): string[] =>
  jobBlocks(text)
    .filter((job) => readsSecrets(job) && !hasEnvironment(job))
    .map((job) => `${path}: ${jobName(job)}`);

const SCRIPT_FIXTURE = `      - name: Example
        env:
          NAME: \${{ inputs.name }}
        run: |
          echo "\${{ github.event.issue.title }}"

          echo "$NAME"
      - run: echo \${{ inputs.name }}
      - name: Next
        with:
          ref: \${{ inputs.ref }}`;

const JOBS_FIXTURE = `jobs:
  open:
    runs-on: ubuntu-latest
    steps:
      - run: deploy
        env:
          KEY: \${{ secrets.DEPLOY_KEY }}
  guarded:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: deploy
        env:
          KEY: \${{ secrets.DEPLOY_KEY }}
  plain:
    runs-on: ubuntu-latest
    steps:
      - run: test`;

/** A line of the credentials action that masks or outputs a database value. */
const DATABASE_MASK_OR_OUTPUT = /^echo "(::add-mask::\$db_|db_\w+=)/;

describe("workflow secrets", () => {
  // A repository secret is open to every branch a person pushes. An
  // environment secret is open only to the branches the environment allows.
  test("every job that reads a secret names an environment", () => {
    expect(flatMap(secretJobsWithoutEnvironment)(workflowFiles())).toEqual([]);
  });

  // GitHub writes a run input to the public job log. Only a secret is masked.
  test("no workflow reads a credential from a run input", () => {
    expect(flatMap(credentialInputs)(workflowFiles())).toEqual([]);
  });

  // GitHub pastes an expression into the script before the shell reads it,
  // so a caller's value there runs as code. An `env:` entry stays data.
  test("no script expands a value the caller controls", () => {
    const files = [...workflowFiles(), ...actionFiles()];
    expect(flatMap(callerValuesInScripts)(files)).toEqual([]);
  });

  test("the scan finds a caller's value in a script and ignores env", () => {
    const found = callerValuesInScripts({
      path: "example.yml",
      text: SCRIPT_FIXTURE,
    });

    // The block script line and the one-line script, not the env or with.
    const [, , , , blockLine, , , oneLine] = SCRIPT_FIXTURE.split("\n");
    expect(found).toEqual([
      `example.yml: ${blockLine!.trim()}`,
      `example.yml: ${oneLine!.trim().replace("- run: ", "")}`,
    ]);
  });

  test("the scan names a job that reads a secret with no environment", () => {
    const found = secretJobsWithoutEnvironment({
      path: "example.yml",
      text: JOBS_FIXTURE,
    });

    expect(found).toEqual(["example.yml: open"]);
  });

  // A step output is not a secret. GitHub prints it in the env of the step
  // that reads it unless a mask names the value first.
  test("the credentials action masks each credential before it is an output", () => {
    const lines = map((line: string) => line.trim())(
      yamlFile(RESOLVE_ACTION_PATH).text.split("\n"),
    );

    expect(
      filter((line: string) => DATABASE_MASK_OR_OUTPUT.test(line))(lines),
    ).toEqual([
      'echo "::add-mask::$db_url"',
      'echo "::add-mask::$db_token"',
      'echo "db_url=$db_url" >> "$GITHUB_OUTPUT"',
      'echo "db_token=$db_token" >> "$GITHUB_OUTPUT"',
    ]);
  });
});
