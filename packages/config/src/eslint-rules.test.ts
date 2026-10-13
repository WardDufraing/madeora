import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import { noServerEnvInClient } from "../eslint/rules/no-server-env-in-client.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: "module" } });

tester.run("no-server-env-in-client", noServerEnvInClient, {
  valid: [
    'import { getServerEnv } from "@madeora/config/env/server";',
    '"use server";\nimport { getServerEnv } from "@madeora/config/env/server";',
    '"use client";\nimport { getPublicEnv } from "@madeora/config/env/public";',
    '"use client";\nimport { useState } from "react";',
    // A "use client" string that is not a leading directive does not make a client module.
    'import x from "y";\n"use client";\nimport { getServerEnv } from "@madeora/config/env/server";',
  ],
  invalid: [
    {
      code: '"use client";\nimport { getServerEnv } from "@madeora/config/env/server";',
      errors: [{ messageId: "serverOnly" }],
    },
    {
      code: "'use strict';\n'use client';\nimport \"server-only\";",
      errors: [{ messageId: "serverOnly" }],
    },
    {
      code: '"use client";\nexport { getServerEnv } from "@madeora/config/env/server";',
      errors: [{ messageId: "serverOnly" }],
    },
    {
      code: '"use client";\nexport * from "@madeora/config/env/server";',
      errors: [{ messageId: "serverOnly" }],
    },
    {
      code: '"use client";\nconst env = await import("@madeora/config/env/server");',
      errors: [{ messageId: "serverOnly" }],
    },
  ],
});
