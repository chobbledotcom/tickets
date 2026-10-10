import { join } from "@std/path";
import {
  auditEquivalentMutants,
  type EquivalentAuditDeps,
} from "#scripts/mutation/equivalent-audit.ts";
import type { StaticGate } from "#scripts/mutation/execution.ts";
import { generateMutants } from "#scripts/mutation/generate.ts";
import { requireValue } from "#shared/required-value.ts";
import { tempDir } from "#test-utils/files.ts";

export const source = "export const value = maybe ?? 0;\n";

export const setup = async () => {
  const dir = tempDir({ prefix: "equivalent-audit-" });
  const sourceFile = join(dir.path, "source.ts");
  const ignoreFile = join(dir.path, "equivalents.txt");
  await Deno.writeTextFile(sourceFile, source);
  const mutant = requireValue(
    generateMutants(source, sourceFile, true).find(
      (entry) => entry.operator === "??" && entry.newOperator === "||",
    ),
    "Expected nullish mutant",
  );
  const entry = `source.ts::${mutant.anchor}  ?? → ||   # same fallback\n`;
  await Deno.writeTextFile(ignoreFile, `# kept comment\n\n${entry}`);
  return { dir, entry, ignoreFile, sourceFile };
};

export const gate = (
  label: "lint" | "type-check",
  exit: StaticGate["exit"],
): StaticGate => ({ exit, label, phase: label, remedy: [] });

export const deps = (gates: StaticGate[]): EquivalentAuditDeps => ({
  createGates: () => Promise.resolve(gates),
});

export const auditSetup = (
  state: Awaited<ReturnType<typeof setup>>,
  gates: StaticGate[] = [],
  write = false,
) =>
  auditEquivalentMutants(
    { ignoreFiles: [state.ignoreFile], root: state.dir.path, write },
    deps(gates),
  );
