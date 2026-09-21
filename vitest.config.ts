import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["apps/server/src/**/*.test.ts", "apps/web/src/**/*.test.ts"],
  },
});
