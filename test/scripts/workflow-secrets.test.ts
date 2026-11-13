import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { filter, flatMap, map, unique } from "#fp";

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
    .filter((entry) => /\.ya?ml$/.test(entry.name))
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

const secretNames = (text: string): string[] =>
  unique([...text.matchAll(/\bsecrets\.([A-Z_]+)/g)].map(([, name]) => name!));

const isDeployJob = (job: string): boolean =>
  /^ {4}environment: (staging|production)$/m.test(job);

/** The steps of a job, each without the `- ` that starts it. */
const jobSteps = (job: string): string[] => job.split(/^ {6}- /m).slice(1);

const isSecretCheck = (step: string): boolean =>
  step.startsWith("name: Check the secrets this run needs\n");

const usesRepositoryAction = (step: string): boolean =>
  step.includes("uses: $/.github/actions/");

/** The check for values that are not set, then the check for wrong values. */
const CHECK_SCRIPTS = [
  "scripts/ci/require-env.sh",
  "scripts/ci/check-credentials.sh",
];

/** Says what is wrong with the secret check of one deploy job. */
const secretCheckProblems = (job: string): string[] => {
  const steps = jobSteps(job);
  const checkAt = steps.findIndex(isSecretCheck);
  if (checkAt < 0) return ["has no secret check"];
  const firstAction = steps.findIndex(usesRepositoryAction);
  const check = steps[checkAt]!;
  const checked = secretNames(check);
  const order =
    firstAction >= 0 && firstAction < checkAt
      ? ["runs a repository action before the secret check"]
      : [];
  return order.concat(
    CHECK_SCRIPTS.filter((script) => !check.includes(script)).map(
      (script) => `does not run ${script}`,
    ),
    secretNames(job)
      .filter((name) => !checked.includes(name))
      .map((name) => `does not check ${name}`),
  );
};

const problemsOfJob =
  (path: string) =>
  (job: string): string[] =>
    secretCheckProblems(job).map(
      (problem) => `${path}: ${jobName(job)} ${problem}`,
    );

/** Names each deploy job whose secret check is absent, late, or incomplete. */
const deploySecretCheckProblems = ({ path, text }: YamlFile): string[] =>
  flatMap(problemsOfJob(path))(jobBlocks(text).filter(isDeployJob));

const DEPLOY_JOBS_FIXTURE = `jobs:
  unchecked:
    environment: production
    steps:
      - run: deploy
        env:
          KEY: \${{ secrets.DEPLOY_KEY }}
  late:
    environment: staging
    steps:
      - uses: $/.github/actions/build
        with:
          zone: \${{ secrets.ZONE }}
      - name: Check the secrets this run needs
        env:
          KEY: \${{ secrets.DEPLOY_KEY }}
        run: scripts/ci/require-env.sh KEY
  complete:
    environment: production
    steps:
      - name: Check the secrets this run needs
        env:
          KEY: \${{ secrets.DEPLOY_KEY }}
        run: |
          scripts/ci/require-env.sh KEY
          scripts/ci/check-credentials.sh bunny
      - uses: $/.github/actions/build
        with:
          key: \${{ secrets.DEPLOY_KEY }}
  sandbox:
    environment: sandbox
    steps:
      - run: test
        env:
          KEY: \${{ secrets.SANDBOX_KEY }}`;

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

  // A deploy that finds a missing secret part of the way through leaves a
  // site in update mode. The check runs before the build and names every
  // secret the job reads, so a new secret cannot skip it.
  test("every deploy job checks each secret it reads before the build", () => {
    expect(flatMap(deploySecretCheckProblems)(workflowFiles())).toEqual([]);
  });

  test("the scan names a deploy job with an absent, late, or partial check", () => {
    const found = deploySecretCheckProblems({
      path: "example.yml",
      text: DEPLOY_JOBS_FIXTURE,
    });

    expect(found).toEqual([
      "example.yml: unchecked has no secret check",
      "example.yml: late runs a repository action before the secret check",
      "example.yml: late does not run scripts/ci/check-credentials.sh",
      "example.yml: late does not check ZONE",
    ]);
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
