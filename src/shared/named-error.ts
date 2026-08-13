/** A base class for named `Error` subclasses.
 *
 * Returns an anonymous `Error` subclass whose instances carry `name`, so a
 * concrete error is just `class MyError extends namedError("MyError") {}` — no
 * repeated `constructor(message) { super(message); this.name = … }` boilerplate.
 * The concrete subclass stays a real named class, so it works as both a value
 * (`new`, `instanceof`) and a type.
 */
export const namedError = (name: string): (new (message?: string) => Error) =>
  class extends Error {
    constructor(message?: string) {
      super(message);
      this.name = name;
    }
  };

/** True when a fetch was aborted, including an abort caused by its timeout. */
export const isAbortOrTimeoutError = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === "AbortError" || error.name === "TimeoutError");

/** True only for the timeout form of a fetch abort. */
export const isTimeoutError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "TimeoutError";
