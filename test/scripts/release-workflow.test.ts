import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { walkSourceFiles } from "#test-utils/walk-src.ts";

const imagePath = ".github/workflows/publish-image.yml";
const releasePath = ".github/workflows/release.yml";
const readImage = (): string => Deno.readTextFileSync(imagePath);

const publishImage = async (response: string, status = 0, failCommand = "") => {
  const workflow = readImage();
  const script = workflow
    .slice(workflow.lastIndexOf("        run: |\n"))
    .split("\n")
    .slice(1)
    .map((line) => line.slice(10))
    .join("\n");
  const result = await new Deno.Command("bash", {
    args: [
      "-c",
      `
      podman() {
        printf 'engine %s\\n' "$*"
        if [ "$1" = login ]; then read -r token; fi
        [ "$*" != "$FAIL_COMMAND" ]
      }
      curl() {
        printf 'request %s\\n' "$*" >&2
        printf '%s' "$RESPONSE"
        return "$STATUS"
      }
      ${script}
    `,
    ],
    env: {
      FAIL_COMMAND: failCommand,
      GHCR_TOKEN: "test-token",
      GHCR_USER: "test-owner",
      GITHUB_REPOSITORY: "chobbledotcom/tickets",
      GITHUB_SHA: "release-commit",
      RELEASE_TAG: "release-tag",
      RESPONSE: response,
      STATUS: String(status),
    },
    stderr: "piped",
    stdout: "piped",
  }).output();
  return {
    code: result.code,
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout),
  };
};

describe("Release image publication", () => {
  test("accepts only a reusable workflow call", () => {
    const triggers = readImage().match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1];
    expect(triggers?.trim()).toBe(
      [
        "workflow_call:",
        "    inputs:",
        "      release_tag:",
        "        required: true",
        "        type: string",
      ].join("\n"),
    );
  });

  test("publishes only after the release job succeeds", () => {
    const workflow = Deno.readTextFileSync(releasePath);
    expect(workflow).toContain(
      [
        "  publish-image:",
        "    needs: release",
        "    permissions:",
        "      contents: read",
        "      packages: write",
        "    uses: ./.github/workflows/publish-image.yml",
        "    with:",
        ["      release_tag: $", "{{ needs.release.outputs.tag }}"].join(""),
      ].join("\n"),
    );
    expect(workflow).not.toMatch(
      /always\(\)|continue-on-error:|secrets: inherit/,
    );
    expect(workflow).toMatch(
      /tag: \$\{\{ steps\.create-release\.outputs\.tag }}/,
    );
    expect(workflow).toContain("id: create-release");
    expect(
      workflow.indexOf('echo "tag=$TAG" >> "$GITHUB_OUTPUT"'),
    ).toBeGreaterThan(workflow.indexOf('gh release create "$TAG"'));
  });

  test("grants registry writes only to the image job", () => {
    const workflow = Deno.readTextFileSync(releasePath);
    expect(workflow).toContain("\npermissions:\n  contents: read\n");
    expect(workflow).toContain(
      "  release:\n    permissions:\n      contents: write\n",
    );
    expect(workflow.match(/packages: write/g)).toHaveLength(1);
  });

  test("has no caller outside Create Release", () => {
    const callers = walkSourceFiles(".github/workflows", [
      ".yml",
      ".yaml",
    ]).filter((path) =>
      Deno.readTextFileSync(path).includes(`uses: ./${imagePath}`),
    );
    expect(callers).toEqual([releasePath]);
  });

  test("retains the repository and main branch restrictions", () => {
    expect(readImage()).toContain(
      "if: github.repository == 'chobbledotcom/tickets' && github.ref == 'refs/heads/main'",
    );
  });

  test("builds the release commit before a serialised publication", () => {
    const workflow = readImage();
    expect(workflow).toMatch(/ref: \$\{\{ github\.sha }}/);
    expect(workflow).toMatch(/RELEASE_TAG: \$\{\{ inputs\.release_tag }}/);
    expect(workflow).toContain(
      "group: publish-image\n  cancel-in-progress: false",
    );
    const commands = [
      "run: container-build",
      "run: container-load",
      "run: container-check",
      "name: Copy the image",
    ];
    const positions = commands.map((command) => workflow.indexOf(command));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("queues release images without replacement by older retries", () => {
    expect(readImage()).toContain(
      "group: publish-image\n  cancel-in-progress: false\n  queue: max",
    );
  });

  test("promotes the latest release even if main advances", async () => {
    const result = await publishImage(
      '{"tag_name":"release-tag","sha":"new-main-commit"}',
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      "/repos/chobbledotcom/tickets/releases/latest",
    );
    expect(result.stdout.trim().split("\n")).toEqual([
      "engine login ghcr.io -u test-owner --password-stdin",
      "engine tag ghcr.io/chobbledotcom/tickets:latest ghcr.io/chobbledotcom/tickets:sha-release-commit",
      "engine push ghcr.io/chobbledotcom/tickets:sha-release-commit",
      "engine push ghcr.io/chobbledotcom/tickets:latest",
    ]);
  });

  test("keeps an older release retry away from latest", async () => {
    const result = await publishImage('{"tag_name":"new-release"}');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "engine push ghcr.io/chobbledotcom/tickets:sha-release-commit",
    );
    expect(result.stdout).not.toContain(
      "engine push ghcr.io/chobbledotcom/tickets:latest",
    );
  });

  for (const [label, response, status] of [
    ["failed API request", '{"tag_name":"release-tag"}', 22],
    ["invalid JSON", "not json", 0],
    ["missing tag", "{}", 0],
    ["empty tag", '{"tag_name":""}', 0],
    ["non-string tag", '{"tag_name":42}', 0],
  ] as const) {
    test(`refuses latest on ${label}`, async () => {
      const result = await publishImage(response, status);
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain(
        "engine push ghcr.io/chobbledotcom/tickets:latest",
      );
    });
  }

  test("stops publication when the commit image push fails", async () => {
    const result = await publishImage(
      '{"tag_name":"release-tag"}',
      0,
      "push ghcr.io/chobbledotcom/tickets:sha-release-commit",
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(
      "engine push ghcr.io/chobbledotcom/tickets:latest",
    );
  });

  test("reports a failed latest push instead of success", async () => {
    const result = await publishImage(
      '{"tag_name":"release-tag"}',
      0,
      "push ghcr.io/chobbledotcom/tickets:latest",
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain(
      "engine push ghcr.io/chobbledotcom/tickets:sha-release-commit",
    );
  });
});
