// Flags server-only modules imported directly by a file marked "use client". `pnpm test:boundary`
// (a real `next build`) also catches indirect imports; this rule gives the same feedback earlier,
// in the editor and in `pnpm lint`.

const SERVER_ONLY_MODULES = ["@madeora/config/env/server", "server-only"];

/** @param {import("estree").Program} program */
function isClientModule(program) {
  for (const statement of program.body) {
    if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string")
      return false;
    if (statement.directive === "use client") return true;
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
export const noServerEnvInClient = {
  meta: {
    type: "problem",
    docs: { description: 'Disallow importing server-only settings in "use client" files.' },
    schema: [],
    messages: {
      serverOnly:
        '"{{source}}" is server-only and must not be imported by a "use client" file. Read the value on the server and pass it down as a prop.',
    },
  },
  create(context) {
    let client = false;

    /** @param {import("estree").Node | null | undefined} source */
    function check(source) {
      if (!client || source?.type !== "Literal" || typeof source.value !== "string") return;
      if (SERVER_ONLY_MODULES.includes(source.value)) {
        context.report({ node: source, messageId: "serverOnly", data: { source: source.value } });
      }
    }

    return {
      Program(node) {
        client = isClientModule(node);
      },
      ImportDeclaration(node) {
        check(node.source);
      },
      ExportNamedDeclaration(node) {
        check(node.source);
      },
      ExportAllDeclaration(node) {
        check(node.source);
      },
      ImportExpression(node) {
        check(node.source);
      },
    };
  },
};

export const madeoraPlugin = {
  meta: { name: "madeora" },
  rules: { "no-server-env-in-client": noServerEnvInClient },
};
