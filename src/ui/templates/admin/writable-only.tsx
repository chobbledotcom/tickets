import type { Child } from "#jsx/jsx-runtime.ts";
import { isReadOnly } from "#shared/env.ts";

export const WritableOnly = ({
  children,
}: {
  children: JSX.Element;
}): JSX.Element | null => (isReadOnly() ? null : children);

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
