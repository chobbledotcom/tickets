import type { Child } from "#jsx/jsx-runtime.ts";
import { Flash } from "#shared/forms.tsx";
import type { ListingWithCount } from "#shared/types.ts";

export type ListingPanelProps = {
  listing: ListingWithCount;
  error?: string | undefined;
};

const ListingPanelFrame = ({
  children,
  error,
  footer,
  heading,
}: {
  children: Child;
  error?: string | undefined;
  footer: Child;
  heading: string;
}): JSX.Element => (
  <>
    <h1>{heading}</h1>
    <Flash error={error} />
    {children}
    {footer}
  </>
);

export const listingChoicePanel = <T,>(
  heading: string,
  error: string | undefined,
  footer: Child,
  items: T[],
  renderEmpty: () => Child,
  renderItems: (items: T[]) => Child,
): JSX.Element => (
  <ListingPanelFrame error={error} footer={footer} heading={heading}>
    {items.length === 0 ? renderEmpty() : renderItems(items)}
  </ListingPanelFrame>
);
