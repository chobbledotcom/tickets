import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

const WORKFLOW_PATH = ".github/workflows/opencode.yml";
const SHA = "[a-f0-9]{40}";
const GATE_SCRIPT_MARKER = "          script: |\n";
const GATE_SCRIPT_INDENT = "            ";

type GatePayload = {
  issue?: {
    author_association?: string;
    body?: string;
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

type GateCore = {
  info: (message: string) => void;
  setOutput: (name: string, value: string) => void;
};

type GateFunction = (
  context: GateContext,
  github: unknown,
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

const runGate = async (payload: GatePayload, eventName = "issues") => {
  const outputs = new Map<string, string>();
  const script = gateScriptFrom(await readWorkflow());
  const gate = new AsyncFunction("context", "github", "core", script);
  const context: GateContext = {
    eventName,
    payload,
    repo: { owner: "chobbledotcom", repo: "tickets" },
  };
  const core: GateCore = {
    info: () => undefined,
    setOutput: (name, value) => outputs.set(name, value),
  };

  await gate(context, {}, core);

  return {
    shouldRun: outputs.get("should_run") === "true",
  };
};

describe("OpenCode workflow", () => {
  test("grants the token scopes needed before checkout", async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("pull-requests: read");
  });

  test("only triggers on newly opened issues", async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain("issues:\n    types: [opened]");
    expect(workflow).not.toContain("issue_comment:");
    expect(workflow).not.toContain("pull_request_review_comment:");
  });

  test("checks the command token before using secrets", async () => {
    const workflow = await readWorkflow();

    expect(workflow).not.toContain("contains(github.event.comment.body");
    expect(workflow).toContain("OPEN_CODE_COMMAND");
    expect(workflow).toContain("steps.gate.outputs.should_run == 'true'");

    const gatePosition = positionOf(workflow, "name: Check OpenCode request");
    const checkoutPosition = positionOf(workflow, "name: Checkout repository");
    const installPosition = positionOf(workflow, "name: Install OpenCode");
    const keyPosition = positionOf(workflow, "NEURALWATT_API_KEY");

    expect(gatePosition).toBeLessThan(checkoutPosition);
    expect(checkoutPosition).toBeLessThan(installPosition);
    expect(gatePosition).toBeLessThan(keyPosition);
  });

  test("runs when a trusted issue mentions OpenCode inline", async () => {
    const result = await runGate({
      issue: {
        author_association: "OWNER",
        body: "Please investigate this bug /oc",
      },
    });

    expect(result.shouldRun).toBe(true);
  });

  test("runs for trusted issues opening with the OpenCode command", async () => {
    const result = await runGate({
      issue: {
        author_association: "MEMBER",
        body: "/opencode summarize the problem",
      },
    });

    expect(result.shouldRun).toBe(true);
  });

  test("ignores issues without the OpenCode command", async () => {
    const result = await runGate({
      issue: {
        author_association: "OWNER",
        body: "Just a regular issue with no command",
      },
    });

    expect(result.shouldRun).toBe(false);
  });

  test("ignores the OpenCode command from untrusted authors", async () => {
    const result = await runGate({
      issue: {
        author_association: "NONE",
        body: "/oc do something",
      },
    });

    expect(result.shouldRun).toBe(false);
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
