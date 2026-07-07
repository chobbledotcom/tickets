import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

const WORKFLOW_PATH = ".github/workflows/opencode.yml";
const SHA = "[a-f0-9]{40}";

const readWorkflow = (): Promise<string> => Deno.readTextFile(WORKFLOW_PATH);

const positionOf = (text: string, phrase: string): number => {
  const position = text.indexOf(phrase);
  expect(position).toBeGreaterThanOrEqual(0);
  return position;
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
    expect(workflow).toContain('command === "/oc"');
    expect(workflow).toContain('command === "/opencode"');
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
