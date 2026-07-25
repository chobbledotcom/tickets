import {
  type Envelope,
  type TestStep,
  TestStepResultStatus,
} from "@cucumber/messages";
import { filter, flatMap, map, mapNotNullish } from "#fp";

const REJECTED_STATUSES = new Set([
  TestStepResultStatus.AMBIGUOUS,
  TestStepResultStatus.PENDING,
  TestStepResultStatus.SKIPPED,
  TestStepResultStatus.UNDEFINED,
]);

const definitionId = (message: Envelope): string | undefined =>
  message.stepDefinition?.id;

const usedDefinitionIds = (message: Envelope): string[] =>
  flatMap((step: TestStep) => [...(step.stepDefinitionIds ?? [])])([
    ...(message.testCase?.testSteps ?? []),
  ]);

const executionIssues = (message: Envelope): string[] => {
  const status = message.testStepFinished?.testStepResult?.status;
  return [
    ...((message.testCaseStarted?.attempt ?? 0) > 0
      ? ["Cucumber retries are forbidden"]
      : []),
    ...(status && REJECTED_STATUSES.has(status)
      ? [`Cucumber step finished as ${status}`]
      : []),
  ];
};

const unusedIssues = (definitions: string[], used: Set<string>): string[] =>
  map((id: string) => `Unused Cucumber step definition ${id}`)(
    filter((id: string) => !used.has(id))(definitions),
  );

export const messageIssues = (
  messages: Envelope[],
  enforceUnused: boolean,
): string[] => {
  const definitions = mapNotNullish(definitionId)(messages);
  const used = new Set(flatMap(usedDefinitionIds)(messages));
  const issues = [
    ...(messages.some((message) => message.testCaseStarted)
      ? []
      : ["Cucumber selected no scenarios"]),
    ...flatMap(executionIssues)(messages),
    ...(enforceUnused ? unusedIssues(definitions, used) : []),
  ];
  return [...new Set(issues)].sort();
};
