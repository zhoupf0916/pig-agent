import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["server/src/**/*.test.ts", "web/src/**/*.test.ts"],
  },
});
