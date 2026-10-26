import { join, relative, resolve } from "node:path";
import { makeScratchDir } from "#scripts/scratch.ts";
import { ensureJscpd } from "./jscpd/install.ts";
import {
  type PreparedSource,
  prepareSource,
  translateReport,
} from "./tla-cpd/prepare.ts";

const collectSources = async (inputs: readonly string[]): Promise<string[]> => {
  const files = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    const info = await Deno.lstat(path);
    if (info.isSymlink) throw new Error(`Symlink is not a TLA source: ${path}`);
    if (info.isDirectory) {
      for await (const entry of Deno.readDir(path))
        await visit(join(path, entry.name));
    } else if (info.isFile && path.endsWith(".tla")) {
      files.add(resolve(path));
    }
  };
  for (const input of inputs) await visit(input);
  if (files.size === 0) throw new Error("No TLA source inputs found");
  return [...files].sort();
};

export const checkTla = async (inputs: readonly string[]): Promise<number> => {
  const files = await collectSources(inputs);
  const work = await makeScratchDir("tla-cpd-");
  try {
    const preparedDirectory = resolve(work, "tokens");
    const outputDirectory = resolve(work, "report");
    await Deno.mkdir(preparedDirectory);
    const sources = new Map<string, PreparedSource>();
    let tokenCount = 0;
    for (const [index, file] of files.entries()) {
      const prepared = prepareSource(
        relative(Deno.cwd(), file),
        await Deno.readTextFile(file),
      );
      tokenCount += prepared.tokens.length;
      const path = join(preparedDirectory, `${index}.txt`);
      await Deno.writeTextFile(path, prepared.encoded);
      sources.set(path, prepared);
    }
    if (tokenCount === 0)
      throw new Error("No TLA tokens found in prepared inputs");
    const config = resolve(work, "jscpd.json");
    await Deno.writeTextFile(
      config,
      JSON.stringify({
        absolute: true,
        exitCode: 1,
        format: ["txt"],
        gitignore: false,
        minLines: 1,
        minTokens: 19,
        noTips: true,
        output: outputDirectory,
        reporters: ["json"],
        threshold: 0,
      }),
    );
    const result = await new Deno.Command(await ensureJscpd(), {
      args: ["--config", config, preparedDirectory],
      stderr: "piped",
      stdout: "piped",
    }).output();
    const reportPath = join(outputDirectory, "jscpd-report.json");
    const report = translateReport(
      JSON.parse(await Deno.readTextFile(reportPath)),
      sources,
    );
    await Deno.mkdir(".scratch/tla-cpd-report", { recursive: true });
    await Deno.writeTextFile(
      ".scratch/tla-cpd-report/jscpd-report.json",
      JSON.stringify(report, null, 2),
    );
    const duplicates = report.duplicates;
    if (!Array.isArray(duplicates))
      throw new Error("Missing translated clones");
    for (const clone of duplicates) {
      const { firstFile, secondFile } = clone;
      console.error(
        `TLA clone: ${firstFile.name}:${firstFile.startLoc.line}:${firstFile.startLoc.column}-${firstFile.endLoc.line}:${firstFile.endLoc.column}`,
      );
      console.error(
        `       and ${secondFile.name}:${secondFile.startLoc.line}:${secondFile.startLoc.column}-${secondFile.endLoc.line}:${secondFile.endLoc.column}`,
      );
    }
    if (duplicates.length > 0) {
      console.error(
        "TLA duplication exceeds the non-negotiable 0% threshold. Extract a shared rule; do not rename, reorder, exclude sources or add ignore tags to hide duplication.",
      );
      return 1;
    }
    if (!result.success) {
      throw new Error(
        `jscpd failed (${result.code}): ${new TextDecoder().decode(result.stderr)}${new TextDecoder().decode(result.stdout)}`,
      );
    }
    console.log(
      `TLA CPD: ${files.length} sources, ${tokenCount} tokens, no clones`,
    );
    return 0;
  } finally {
    await Deno.remove(work, { recursive: true });
  }
};

if (import.meta.main) {
  try {
    Deno.exit(
      await checkTla(Deno.args.length === 0 ? ["verification"] : Deno.args),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
