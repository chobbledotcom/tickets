import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  readsABuiltStatement,
  readsAHandNumberedToken,
  readsARepeatedBind,
  readsEverySourceFile,
  readsTheAllowedAssembly,
  readsTheNeighbouringAssembly,
} from "#test/specs/support/code-standard.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

When(
  "the code-quality job reads a statement that binds the same value twice",
  function (this: TicketsWorld): void {
    readsARepeatedBind(this);
  },
);

When(
  "the code-quality job reads a statement built through the numbered builder",
  function (this: TicketsWorld): void {
    readsABuiltStatement(this);
  },
);

When(
  "the code-quality job reads SQL text that spells a numbered parameter itself",
  function (this: TicketsWorld): void {
    readsAHandNumberedToken(this);
  },
);

When(
  "the code-quality job reads the allowed clause assembly binding its parts twice",
  function (this: TicketsWorld): void {
    readsTheAllowedAssembly(this);
  },
);

When(
  "the code-quality job reads the same file with another assembly binding one value twice",
  function (this: TicketsWorld): void {
    readsTheNeighbouringAssembly(this);
  },
);

When(
  "the code-quality job reads every source file the site has",
  function (this: TicketsWorld): Promise<void> {
    return readsEverySourceFile(this);
  },
);

Then(
  "the job fails, naming the file and the line of the repeated value",
  function (this: TicketsWorld): void {
    expect(
      requiredWorldValue(this.codeStandardFindings, "what the job reported"),
    ).toEqual([
      "shared/db/synthetic.ts:2: binds listingId more than once; numberedStatement binds it once and reuses the token",
    ]);
  },
);

Then(
  "the job fails, naming the file and the line of the parameter",
  function (this: TicketsWorld): void {
    expect(
      requiredWorldValue(this.codeStandardFindings, "what the job reported"),
    ).toEqual([
      "shared/db/synthetic.ts:1: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead",
    ]);
  },
);

Then("the job passes it", function (this: TicketsWorld): void {
  expect(
    requiredWorldValue(this.codeStandardFindings, "what the job reported"),
  ).toEqual([]);
});

Then("the job passes them all", function (this: TicketsWorld): void {
  expect(
    requiredWorldValue(this.codeStandardFindings, "what the job reported"),
  ).toEqual([]);
});

Then(
  "the job names the neighbouring assembly's line",
  function (this: TicketsWorld): void {
    expect(
      requiredWorldValue(this.codeStandardFindings, "what the job reported"),
    ).toEqual([
      "shared/accounting/queries.ts:5: binds id more than once; numberedStatement binds it once and reuses the token",
    ]);
  },
);
