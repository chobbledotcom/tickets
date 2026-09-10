import { expect } from "@std/expect";
import { dirname } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { fakeCommand } from "#test-utils/stripe-mock/helpers.ts";

const withFakeDeno = fakeCommand("deno");
const probe = `
printf '%s\\n' "$@" "setup=$HOOK_SETUP"
for fd in 0 1 2; do
  if [ -t "$fd" ]; then terminal=yes; else terminal=no; fi
  printf 'fd%s=%s\\n' "$fd" "$terminal"
done
printf 'error output\\n' >&2
exit "$HOOK_STATUS"
`;

describe("Git hook output", () => {
  // Capture both streams inside the PTY, as prek does for its child.
  const command =
    'bash -euo pipefail -c "$HOOK" </dev/null >"$CAPTURE_OUT" 2>"$CAPTURE_ERR"';
  const expected = "task\nprecommit\nsetup=ready\nfd0=no\n";
  for (const mode of [
    {
      args: [
        "--quiet",
        "--return",
        "--flush",
        "--command",
        command,
        "/dev/null",
      ],
      err: "",
      live: `${expected}fd1=yes\nfd2=yes\nerror output\n`,
      name: "shows live terminal output",
      out: "",
      program: "script",
    },
    {
      args: ["--fork", "--wait", "bash", "-c", command],
      err: "error output\n",
      live: "",
      name: "preserves captured output",
      out: `${expected}fd1=no\nfd2=no\n`,
      program: "setsid",
    },
  ]) {
    for (const status of [0, 37]) {
      test(`${mode.name} with exit status ${status}`, async () => {
        await withFakeDeno(probe, async (fake) => {
          const dir = dirname(fake);
          const setup = `${dir}/setup.sh`;
          await Deno.writeTextFile(setup, "export HOOK_SETUP=ready\n");
          const hook = (
            await Deno.readTextFile("scripts/devenv/precommit.sh")
          ).replace("@runtimeSetup@", JSON.stringify(setup));
          const result = await new Deno.Command(mode.program, {
            args: mode.args,
            env: {
              CAPTURE_ERR: `${dir}/stderr`,
              CAPTURE_OUT: `${dir}/stdout`,
              HOOK: hook,
              HOOK_STATUS: String(status),
              PATH: `${dir}:${Deno.env.get("PATH")}`,
            },
            stderr: "piped",
            stdin: "null",
            stdout: "piped",
          }).output();
          const output = new TextDecoder()
            .decode(result.stdout)
            .replaceAll("\r\n", "\n");
          expect(result.code).toBe(status);
          expect(new TextDecoder().decode(result.stderr)).toBe("");
          expect(output).toBe(mode.live);
          expect(await Deno.readTextFile(`${dir}/stdout`)).toBe(mode.out);
          expect(await Deno.readTextFile(`${dir}/stderr`)).toBe(mode.err);
        });
      });
    }
  }
});
