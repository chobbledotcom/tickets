import { type Child, SafeHtml } from "#jsx/jsx-runtime.ts";
import { isReadOnly } from "#shared/env.ts";

// Returns an empty SafeHtml (not null) in read-only mode: the JSX factory
// wraps a component's return value with `new SafeHtml(result)`, so a `null`
// return serialises to the literal text "null" instead of disappearing.
// An empty SafeHtml keeps these controls truly hidden on read-only pages.
export const WritableOnly = ({
  children,
}: {
  children: JSX.Element;
}): JSX.Element => (isReadOnly() ? new SafeHtml("") : children);

export const WritableLink = ({
  children,
  class: className,
  href,
}: {
  children: Child;
  class?: string;
  href: string;
}): JSX.Element =>
  isReadOnly() ? (
    <span>{children}</span>
  ) : (
    <a class={className} href={href}>
      {children}
    </a>
  );

export const WritableDangerLink = ({
  children,
  href,
}: {
  children: Child;
  href: string;
}): JSX.Element => (
  <WritableOnly>
    <p>
      <a class="danger" href={href}>
        {children}
      </a>
    </p>
  </WritableOnly>
);
