import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: {
      "@": path.resolve(process.cwd(), "src"),
      // `server-only` throws when imported outside the React Server runtime.
      // Tests exercise server modules directly, so it is stubbed here.
      "server-only": path.resolve(process.cwd(), "tests/stubs/server-only.ts"),
    } },
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
