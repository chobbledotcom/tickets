import type { Child } from "#shared/jsx/jsx-runtime.ts";

type PageGroupProps = {
  as?: "article" | "div" | "section" | undefined;
  children: Child;
  className?: string | undefined;
  id?: string | undefined;
};

type TitledArticleProps = {
  children: Child;
  id?: string | undefined;
  title: Child;
};

const groupClass = (base: string, className?: string): string =>
  className ? `${base} ${className}` : base;

const definePageGroup =
  (base: string) =>
  ({
    as: Tag = "div",
    children,
    className,
    id,
  }: PageGroupProps): JSX.Element => (
    <Tag class={groupClass(base, className)} id={id}>
      {children}
    </Tag>
  );

/** Separates peer regions inside a substantial page panel. */
export const PageRegions = definePageGroup("page-regions");

/** Keeps contextually related content, such as a heading and table, together. */
export const PageBlock = definePageGroup("page-block");

/** An article opened by its section heading. */
export const TitledArticle = ({
  children,
  id,
  title,
}: TitledArticleProps): JSX.Element => (
  <article id={id}>
    <h2>{title}</h2>
    {children}
  </article>
);
