import { spawnSync } from "node:child_process";
import path from "node:path";

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl) {
  console.error("DATABASE_URL_TEST is required; refusing to use DATABASE_URL for integration work.");
  process.exit(1);
}
function databaseIdentity(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.username}@${url.hostname}:${url.port}/${url.pathname}`;
}

if (
  process.env.DATABASE_URL &&
  databaseIdentity(process.env.DATABASE_URL) === databaseIdentity(testDatabaseUrl)
) {
  console.error("DATABASE_URL_TEST must be distinct from DATABASE_URL.");
  process.exit(1);
}

const [tool, ...args] = process.argv.slice(2);
const tools = {
  drizzle: path.resolve("node_modules/drizzle-kit/bin.cjs"),
  seed: path.resolve("node_modules/tsx/dist/cli.mjs"),
  vitest: path.resolve("node_modules/vitest/vitest.mjs"),
};
const entrypoint = tools[tool];
if (!entrypoint) {
  console.error("Unknown test-database tool.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [entrypoint, ...args], {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
