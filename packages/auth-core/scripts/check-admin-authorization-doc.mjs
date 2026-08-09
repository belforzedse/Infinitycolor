import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  ADMIN_ROLE_DEFINITIONS,
  ADMIN_ROLE_IDS,
  capabilitiesForRole,
} from "../dist/admin-authorization.js";

const startMarker = "<!-- BEGIN GENERATED ROLE REGISTRY -->";
const endMarker = "<!-- END GENERATED ROLE REGISTRY -->";

const rows = ADMIN_ROLE_IDS.map((role) => {
  const definition = ADMIN_ROLE_DEFINITIONS[role];
  const inheritance = definition.inherits.length
    ? definition.inherits.map((parent) => `\`${parent}\``).join(" + ")
    : "-";
  return `| \`${role}\` | ${definition.englishLabel} | ${definition.persianLabel} | ${inheritance} | ${capabilitiesForRole(role).length} |`;
});

const generated = [
  startMarker,
  "| Role ID | English label | Persian label | Inherits | Effective capability count |",
  "| --- | --- | --- | --- | ---: |",
  ...rows,
  endMarker,
].join("\n");

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const documentationPath = `${repositoryRoot}/docs/auth/admin-authorization.md`;
const documentation = await readFile(documentationPath, "utf8");
const start = documentation.indexOf(startMarker);
const end = documentation.indexOf(endMarker);

if (start === -1 || end === -1 || end < start) {
  throw new Error(`Generated role-registry markers are missing from ${documentationPath}`);
}

const actual = documentation.slice(start, end + endMarker.length);
if (actual !== generated) {
  throw new Error(
    "Admin authorization documentation is stale; update its generated role-registry section from @repo/auth-core",
  );
}

console.log("Admin authorization documentation matches @repo/auth-core");
