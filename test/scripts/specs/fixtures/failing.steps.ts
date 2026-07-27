import { Given } from "@cucumber/cucumber";

/** A step that always fails, for tests about what a failed run does next. */
Given("a selected example runs", () => {
  throw new Error("this example was meant to fail");
});
