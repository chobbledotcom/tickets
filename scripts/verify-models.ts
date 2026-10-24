/** Run the TLA+ proof of the payment seam.
 *
 *     deno task verify:models
 *
 * Checks verification/JointState.tla with the Apalache model checker: the
 * whole row × authority product under the three coupling guards, up to the
 * reachable diameter (8). The proof holds when the run exits 0 and reports
 * NoError; a counterexample means a machine or a coupling guard moved, and
 * the printed trace names the joint state that came back to life.
 *
 * Needs a JDK and the Apalache distribution. Quint downloads the
 * distribution to ~/.quint/apalache-dist-* on its first verify run; set
 * APALACHE_JAR to point somewhere else. Java resolves from PATH, then from
 * this repo's devenv profile. */

const JAVA_CANDIDATES = ["java", ".devenv/profile/bin/java"];

const firstWorkingJava = async (): Promise<string> => {
  for (const candidate of JAVA_CANDIDATES) {
    // Relative candidates resolve against the repo root, not the checker's
    // scratch working directory.
    const java = candidate.startsWith("/")
      ? candidate
      : `${Deno.cwd()}/${candidate}`;
    try {
      const probe = new Deno.Command(java, {
        args: ["-version"],
        stderr: "null",
        stdout: "null",
      });
      if ((await probe.output()).success) return java;
    } catch {
      // Not on this machine; try the next candidate.
    }
  }
  console.error(
    "No JDK found. Install one through devenv (packages in devenv.nix) or put java on PATH.",
  );
  Deno.exit(1);
};

const apalacheJar = async (): Promise<string> => {
  const override = Deno.env.get("APALACHE_JAR");
  if (override !== undefined) return override;
  const home = Deno.env.get("HOME");
  if (home === undefined) {
    console.error("APALACHE_JAR is unset and $HOME is missing.");
    Deno.exit(1);
  }
  const dists: string[] = [];
  for await (const entry of Deno.readDir(`${home}/.quint`)) {
    if (entry.name.startsWith("apalache-dist-")) {
      dists.push(`${home}/.quint/${entry.name}/apalache/lib/apalache.jar`);
    }
  }
  const jar = dists.sort().at(-1);
  if (jar === undefined || !(await Deno.stat(jar)).isFile) {
    console.error(
      "No Apalache distribution under ~/.quint. Run 'quint verify' once to download it, or set APALACHE_JAR.",
    );
    Deno.exit(1);
  }
  return jar;
};

const spec = "verification/JointState.tla";
const work = await Deno.makeTempDir({ prefix: "verify-models-" });
try {
  // Apalache writes its run artifacts beside the working directory, so the
  // check runs from a scratch dir and the spec goes in by absolute path.
  const run = new Deno.Command(await firstWorkingJava(), {
    args: [
      "-jar",
      await apalacheJar(),
      "check",
      "--inv=SeamOK",
      "--length=8",
      new URL(`file://${Deno.cwd()}/${spec}`).pathname,
    ],
    cwd: work,
    stderr: "inherit",
    stdout: "piped",
  });
  const { success, stdout } = await run.output();
  const out = new TextDecoder().decode(stdout);
  const lines = out
    .split("\n")
    .filter(
      (line) =>
        line.includes("The outcome") ||
        line.includes("Error") ||
        line.includes("error"),
    );
  console.log(lines.join("\n"));
  if (!success || !out.includes("NoError")) {
    console.error(
      "The seam proof failed. A move, a coupling guard, or the invariant changed; read the trace Apalache printed and reconcile it with verification/JointState.tla.",
    );
    Deno.exit(1);
  }
  console.log(
    "The payment seam proof holds: no reachable illegal joint state.",
  );
} finally {
  await Deno.remove(work, { recursive: true });
}
