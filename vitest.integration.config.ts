import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    // A cold or sleeping remote PostgreSQL test branch can take longer than
    // Vitest's default timeout to establish its first TLS connection.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
