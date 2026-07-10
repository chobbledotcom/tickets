import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

const WORKFLOW_PATH = ".github/workflows/opencode.yml";
const SHA = "[a-f0-9]{40}";
const GATE_SCRIPT_MARKER = "          script: |\n";
const GATE_SCRIPT_INDENT = "            ";

type GatePayload = {
  comment?: {
    author_association?: string;
    body?: string;
  };
  issue?: {
    number?: number;
    pull_request?: unknown;
  };
  pull_request?: {
    number?: number;
  };
};

type GateContext = {
  eventName: string;
  payload: GatePayload;
  repo: {
    owner: string;
    repo: string;
  };
};

type PullCheck = {
  owner: string;
  pull_number: number;
  repo: string;
};

type Pull = {
  base: {
    repo?: { full_name?: string } | null;
  };
  head: {
    repo?: { full_name?: string } | null;
  };
};

type GateGithub = {
  rest: {
    pulls: {
      get: (check: PullCheck) => Promise<{ data: Pull }>;
    };
  };
};

type GateCore = {
  info: (message: string) => void;
  setOutput: (name: string, value: string) => void;
};

type GateFunction = (
  context: GateContext,
  github: GateGithub,
  core: GateCore,
) => Promise<void>;

const AsyncFunction = Object.getPrototypeOf(async () => undefined)
  .constructor as new (
  ...args: string[]
) => GateFunction;

const readWorkflow = (): Promise<string> => Deno.readTextFile(WORKFLOW_PATH);

const positionOf = (text: string, phrase: string): number => {
  const position = text.indexOf(phrase);
  expect(position).toBeGreaterThanOrEqual(0);
  return position;
};

const gateScriptFrom = (workflow: string): string => {
  const start =
    positionOf(workflow, GATE_SCRIPT_MARKER) + GATE_SCRIPT_MARKER.length;
  const lines = workflow.slice(start).split("\n");
  const end = lines.findIndex(
    (line) => line.length > 0 && !line.startsWith(GATE_SCRIPT_INDENT),
  );
  return lines
    .slice(0, end === -1 ? lines.length : end)
    .map((line) =>
      line.startsWith(GATE_SCRIPT_INDENT)
        ? line.slice(GATE_SCRIPT_INDENT.length)
        : line,
    )
    .join("\n");
};

const sameRepositoryPull: Pull = {
  base: { repo: { full_name: "chobbledotcom/tickets" } },
  head: { repo: { full_name: "chobbledotcom/tickets" } },
};

const runGate = async (
  payload: GatePayload,
  eventName = "issue_comment",
  pull = sameRepositoryPull,
) => {
  const outputs = new Map<string, string>();
  const pullNumbers: number[] = [];
  const script = gateScriptFrom(await readWorkflow());
  const gate = new AsyncFunction("context", "github", "core", script);
  const context: GateContext = {
    eventName,
    payload,
    repo: { owner: "chobbledotcom", repo: "tickets" },
  };
  const github: GateGithub = {
    rest: {
      pulls: {
        get: (check) => {
          pullNumbers.push(check.pull_number);
          return Promise.resolve({ data: pull });
        },
      },
    },
  };
  const core: GateCore = {
    info: () => undefined,
    setOutput: (name, value) => outputs.set(name, value),
  };

  await gate(context, github, core);

  return {
    pullNumbers,
    shouldRun: outputs.get("should_run") === "true",
  };
};

describe("OpenCode workflow", () => {
  test("grants the token scopes needed before checkout and PR checks", async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("pull-requests: read");
  });

  test("checks the command token and same-repository PR before using secrets", async () => {
    const workflow = await readWorkflow();

    expect(workflow).not.toContain("contains(github.event.comment.body");
    expect(workflow).toContain("OPEN_CODE_COMMAND");
    expect(workflow).toContain("github.rest.pulls.get");
    expect(workflow).toContain("pull.head.repo?.full_name");
    expect(workflow).toContain("pull.base.repo?.full_name");
    expect(workflow).toContain("steps.gate.outputs.should_run == 'true'");

    const gatePosition = positionOf(workflow, "name: Check OpenCode request");
    const checkoutPosition = positionOf(workflow, "name: Checkout repository");
    const installPosition = positionOf(workflow, "name: Install OpenCode");
    const keyPosition = positionOf(workflow, "NEURALWATT_API_KEY");

    expect(gatePosition).toBeLessThan(checkoutPosition);
    expect(checkoutPosition).toBeLessThan(installPosition);
    expect(gatePosition).toBeLessThan(keyPosition);
  });

  test("runs when a trusted PR comment mentions OpenCode inline", async () => {
    const result = await runGate({
      comment: {
        author_association: "OWNER",
        body: "Delete the stale branch /oc",
      },
      issue: { number: 42, pull_request: {} },
    });

    expect(result.shouldRun).toBe(true);
    expect(result.pullNumbers).toEqual([42]);
  });

  test("runs for trusted OpenCode comments on normal issues", async () => {
    const result = await runGate({
      comment: {
        author_association: "MEMBER",
        body: "/opencode summarize the problem",
      },
      issue: { number: 84 },
    });

    expect(result.shouldRun).toBe(true);
    expect(result.pullNumbers).toEqual([]);
  });

  test("pins actions and the OpenCode binary to immutable commits and releases", async () => {
    const workflow = await readWorkflow();

    expect(workflow).toMatch(new RegExp(`uses: actions/github-script@${SHA}`));
    expect(workflow).toMatch(new RegExp(`uses: actions/checkout@${SHA}`));
    expect(workflow).toContain("OPENCODE_VERSION: 1.17.15");
    expect(workflow).toContain(
      "github.com/anomalyco/opencode/releases/download/v$" +
        "{OPENCODE_VERSION}",
    );
    expect(workflow).toContain("opencode github run");
    expect(workflow).not.toContain("anomalyco/opencode/github@");
    expect(workflow).not.toMatch(/uses: .+@latest/);
  });
});
