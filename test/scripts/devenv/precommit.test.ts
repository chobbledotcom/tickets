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
  // prek runs the hook under itself with both streams captured. The parent
  // shell here stands in for prek, and its stdout says who is calling.
  const hookRun = 'bash -c "$HOOK" </dev/null';
  const captured = `bash -euo pipefail -c '${hookRun}' >"$CAPTURE_OUT" 2>"$CAPTURE_ERR"`;
  const capturedLines =
    "task\nprecommit\nsetup=ready\nfd0=no\nfd1=no\nfd2=no\n";
  for (const mode of [
    {
      args: [
        "--quiet",
        "--return",
        "--flush",
        "--command",
        `: >"$CAPTURE_OUT" 2>"$CAPTURE_ERR"; exec bash -euo pipefail -c '${hookRun}'`,
        "/dev/null",
      ],
      env: {},
      err: "",
      live: "task\nprecommit\nsetup=ready\nfd0=no\nfd1=yes\nfd2=yes\nerror output\n",
      name: "shows live terminal output to an interactive caller",
      out: "",
      program: "script",
    },
    {
      args: [
        "--quiet",
        "--return",
        "--flush",
        "--command",
        captured,
        "/dev/null",
      ],
      env: {},
      err: "error output\n",
      live: "",
      name: "keeps captured output for a caller writing to a file",
      out: capturedLines,
      program: "script",
    },
    {
      // The parent's stdout is a real pipe, the shape CI and agents see.
      // `exec bash -o pipefail -c "<CMD>"` keeps the hook's exit status the
      // pipeline's and lets $HOOK expand only inside the hook's own bash.
      args: [
        "--quiet",
        "--return",
        "--flush",
        "--command",
        'exec bash -o pipefail -c "$PIPE_BODY"',
        "/dev/null",
      ],
      env: {
        PIPE_BODY: `bash -euo pipefail -c '${hookRun}' 2>"$CAPTURE_ERR" | cat >"$CAPTURE_OUT"`,
      },
      err: "error output\n",
      live: "",
      name: "keeps captured output for a caller on a pipe",
      out: capturedLines,
      program: "script",
    },
    {
      args: ["--fork", "--wait", "bash", "-c", captured],
      env: {},
      err: "error output\n",
      live: "",
      name: "preserves captured output without a controlling terminal",
      out: capturedLines,
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
              ...mode.env,
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
