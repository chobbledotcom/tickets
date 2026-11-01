import type { VerificationModule } from "#scripts/verify-models/spec.ts";
import { depsOver } from "./support.ts";

export const MODEL_SOURCE = [
  "---- MODULE Sample ----",
  "EXTENDS Integers",
  "VARIABLE value",
  "Init == value = 0",
  "Next == value' = value + 1",
  "Safety == value >= 0",
  "====",
].join("\n");

export const HELPER_SOURCE = [
  "---- MODULE Laws ----",
  "Nonnegative(value) == value >= 0",
  "====",
].join("\n");

export const declaration = (
  kind: "model" | "helper" = "model",
  context: readonly string[] = [],
): VerificationModule =>
  kind === "helper"
    ? { context, kind, module: "Laws" }
    : {
        context,
        controls: [
          {
            data: () => {
              throw new Error("Grading must not execute a control");
            },
            name: "negative",
            phase: "initial",
          },
        ],
        data: () => {
          throw new Error("Grading must not execute a generator");
        },
        kind,
        module: "Sample",
      };

export const tlaDeps = (
  entry = declaration(),
  files: Record<string, string> = { "verification/Sample.tla": MODEL_SOURCE },
) => {
  const deps = depsOver({ files });
  deps.grade.verificationModule = () => entry;
  deps.grade.readContext = (file) => {
    if (!(file in files)) return Promise.reject(new Error(`Missing ${file}`));
    return Promise.resolve(files[file]!);
  };
  deps.grade.fetchText = (_url, init) => {
    const body = JSON.parse(String(init.body));
    return Promise.resolve({
      ok: true,
      status: 200,
      text: JSON.stringify({
        answers: Object.fromEntries(
          Object.keys(body.questions).map((id) => [
            id,
            {
              confidence: 0.9,
              score: 3,
              type: "score",
            },
          ]),
        ),
      }),
    });
  };
  return deps;
};
