#!/usr/bin/env node

import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;

if (!tag) {
  console.error("Usage: node scripts/validate-release-version.mjs <tag>");
  process.exit(1);
}

if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error(`Release tag "${tag}" must match v<major>.<minor>.<patch>.`);
  process.exit(1);
}

const expectedVersion = tag.slice(1);
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const openApiSource = readFileSync(
  new URL("../packages/api/src/openapi.ts", import.meta.url),
  "utf8",
);
const openApiYaml = readFileSync(new URL("../docs/api-openapi.yaml", import.meta.url), "utf8");

const rootVersion = packageJson.version;
const sourceVersion = openApiSource.match(/version:\s*"([^"]+)"/)?.[1];
const yamlVersion = openApiYaml.match(/^  version:\s*(.+)$/m)?.[1]?.trim();

const mismatches = [];

if (rootVersion !== expectedVersion) {
  mismatches.push(`package.json version ${rootVersion} does not match ${expectedVersion}`);
}

if (sourceVersion !== expectedVersion) {
  mismatches.push(
    `packages/api/src/openapi.ts version ${sourceVersion ?? "<missing>"} does not match ${expectedVersion}`,
  );
}

if (yamlVersion !== expectedVersion) {
  mismatches.push(
    `docs/api-openapi.yaml version ${yamlVersion ?? "<missing>"} does not match ${expectedVersion}`,
  );
}

if (mismatches.length > 0) {
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch}`);
  }
  process.exit(1);
}

console.log(`Release metadata matches ${tag}.`);
