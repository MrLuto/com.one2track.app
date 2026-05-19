import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [".homeybuild/**", "node_modules/**"],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
