import type { Node, Program, TSTypeAnnotation } from "npm:oxc-parser@0.132.0";

type Space = "type" | "value";

interface Reference {
  name: string;
  path: string;
}

interface ImportTarget extends Reference {
  imported: string;
  source: string;
}

type Binding =
  | { kind: "import"; target: ImportTarget }
  | {
      annotation: Node | null;
      kind: "alias";
      path: string;
      reference: Reference | null;
    };

type Bindings = Record<Space, Map<string, Binding>>;

interface NamedBinding {
  binding: Binding;
  name: string;
  space: Space;
  start: number;
}

interface ExportName {
  exported: string;
  start: number;
}

type FileExport = ExportName &
  (
    | { kind: "local"; reference: Reference | null; spaces: Space[] }
    | { kind: "foreign"; target: string }
  );

export interface ResolvedExport extends ExportName {
  foreign: boolean;
  target: string;
}

const spelling = (
  node: Extract<Node, { type: "Identifier" | "Literal" }>,
): string => (node.type === "Identifier" ? node.name : String(node.value));

const memberPath = (
  node: Extract<Node, { type: "MemberExpression" | "TSQualifiedName" }>,
  content: string,
): string => {
  if (node.type === "TSQualifiedName") return `.${node.right.name}`;
  const property = content.slice(node.property.start, node.property.end);
  return node.computed ? `[${property}]` : `.${property}`;
};

/** Calls, defaults, and specialisations do not name an unchanged import. */
const referenceOf = (node: Node | null, content: string): Reference | null => {
  if (node === null) return null;
  if (node.type === "Identifier") return { name: node.name, path: "" };
  if (node.type === "TSTypeReference" && node.typeArguments === null) {
    return referenceOf(node.typeName, content);
  }
  if (node.type === "MemberExpression" || node.type === "TSQualifiedName") {
    const root = node.type === "MemberExpression" ? node.object : node.left;
    const reference = referenceOf(root, content);
    if (reference === null) return null;
    return { ...reference, path: reference.path + memberPath(node, content) };
  }
  return null;
};

/** Only plain members retain identity after a destructure. */
const plainName = (node: Node | null, path: string): Reference[] =>
  node?.type === "Identifier" ? [{ name: node.name, path }] : [];

const patternNames = (node: Node): Reference[] => {
  if (node.type === "ObjectPattern") {
    return node.properties.flatMap((property) => {
      if (
        property.type !== "Property" ||
        property.computed ||
        property.key.type !== "Identifier"
      )
        return [];
      return plainName(property.value, `.${property.key.name}`);
    });
  }
  if (node.type === "ArrayPattern") {
    return node.elements.flatMap((element, index) =>
      plainName(element, `[${index}]`),
    );
  }
  return plainName(node, "");
};

const declaredBindings = (node: Node, content: string): NamedBinding[] => {
  if (node.type === "VariableDeclaration") {
    return node.declarations.flatMap((declaration) => {
      // Oxc's pattern types omit the TypeScript annotation that its parser emits.
      const pattern: { typeAnnotation?: TSTypeAnnotation | null } =
        declaration.id;
      const reference =
        node.kind === "const" ? referenceOf(declaration.init, content) : null;
      return patternNames(declaration.id).map((bound) => ({
        binding: {
          annotation: pattern.typeAnnotation?.typeAnnotation ?? null,
          kind: "alias",
          path: bound.path,
          reference,
        },
        name: bound.name,
        space: "value",
        start: declaration.start,
      }));
    });
  }
  if (node.type === "TSTypeAliasDeclaration") {
    return [
      {
        binding: {
          annotation: null,
          kind: "alias",
          path: "",
          reference:
            node.typeParameters === null
              ? referenceOf(node.typeAnnotation, content)
              : null,
        },
        name: node.id.name,
        space: "type",
        start: node.start,
      },
    ];
  }
  return [];
};

const readImport = (
  statement: Extract<Node, { type: "ImportDeclaration" }>,
  bindings: Bindings,
): void => {
  for (const specifier of statement.specifiers) {
    const named = specifier.type === "ImportSpecifier";
    const imported = named
      ? spelling(specifier.imported)
      : specifier.type === "ImportDefaultSpecifier"
        ? "default"
        : "*";
    const binding: Binding = {
      kind: "import",
      target: {
        imported,
        name: imported === "*" ? specifier.local.name : imported,
        path: "",
        source: statement.source.value,
      },
    };
    bindings.type.set(specifier.local.name, binding);
    if (
      statement.importKind !== "type" &&
      !(named && specifier.importKind === "type")
    ) {
      bindings.value.set(specifier.local.name, binding);
    }
  }
};

const clauseExports = (
  statement: Extract<Node, { type: "ExportNamedDeclaration" }>,
): FileExport[] =>
  statement.specifiers.map((specifier) => {
    const name: ExportName = {
      exported: spelling(specifier.exported),
      start: specifier.start,
    };
    const local = spelling(specifier.local);
    return statement.source !== null
      ? { ...name, kind: "foreign", target: local }
      : {
          ...name,
          kind: "local",
          reference: { name: local, path: "" },
          spaces:
            statement.exportKind === "type" || specifier.exportKind === "type"
              ? ["type"]
              : ["value", "type"],
        };
  });

const fileExports = (
  program: Program,
  content: string,
  bindings: Bindings,
): FileExport[] =>
  program.body.flatMap((statement): FileExport[] => {
    const named = statement.type === "ExportNamedDeclaration";
    const declaration = named ? statement.declaration : statement;
    const declared =
      declaration === null ? [] : declaredBindings(declaration, content);
    for (const { binding, name, space } of declared) {
      bindings[space].set(name, binding);
    }
    if (named) {
      return [
        ...clauseExports(statement),
        ...declared.map(
          ({ name, space, start }): FileExport => ({
            exported: name,
            kind: "local",
            reference: { name, path: "" },
            spaces: [space],
            start,
          }),
        ),
      ];
    }
    // `export *` names no single name, so it cannot rename one. The empty
    // answer also covers plain statements, which export nothing.
    return statement.type === "ExportDefaultDeclaration"
      ? [
          {
            exported: "default",
            kind: "local",
            reference: referenceOf(statement.declaration, content),
            spaces: ["value"],
            start: statement.start,
          },
        ]
      : [];
  });

const sameTarget = (
  left: ImportTarget | null,
  right: ImportTarget | null,
): boolean =>
  left !== null &&
  right !== null &&
  left.source === right.source &&
  left.imported === right.imported &&
  left.path === right.path;

/** Resolve both declaration and clause exports through the same local facts. */
export const resolveExports = (
  program: Program,
  content: string,
): ResolvedExport[] => {
  const bindings: Bindings = { type: new Map(), value: new Map() };
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") readImport(statement, bindings);
  }
  const exports = fileExports(program, content, bindings);

  // A cycle has no imported root. The active set belongs to one resolution.
  const resolve = (
    reference: Reference | null,
    space: Space,
    active: Set<Binding>,
  ): ImportTarget | null => {
    if (reference === null) return null;
    const binding = bindings[space].get(reference.name);
    if (binding === undefined || active.has(binding)) return null;
    if (binding.kind === "import") {
      return { ...binding.target, path: reference.path };
    }
    active.add(binding);
    const target = resolve(binding.reference, space, active);
    const annotation = binding.annotation;
    const repeatsTarget =
      annotation === null ||
      (annotation.type === "TSTypeQuery" &&
        annotation.typeArguments === null &&
        sameTarget(
          target,
          resolve(referenceOf(annotation.exprName, content), "value", active),
        ));
    active.delete(binding);
    return target !== null && repeatsTarget
      ? { ...target, path: target.path + binding.path + reference.path }
      : null;
  };

  return exports.flatMap((entry) => {
    const targets =
      entry.kind === "foreign"
        ? [entry.target].filter((target) => target !== entry.exported)
        : entry.spaces.flatMap((space) => {
            const target = resolve(entry.reference, space, new Set());
            if (
              target === null ||
              (target.path === "" && target.name === entry.exported)
            )
              return [];
            return [target.name + target.path];
          });
    return [...new Set(targets)].map((target) => ({
      exported: entry.exported,
      foreign: entry.kind === "foreign",
      start: entry.start,
      target,
    }));
  });
};
