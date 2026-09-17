import { defineConfig } from "vitest/config";
import path from "path";
import fs from "fs";

export default defineConfig({
  plugins: [
    {
      name: "html-text-loader",
      enforce: "pre",
      load(id) {
        const cleanId = id.split("?")[0];
        if (cleanId.endsWith(".html")) {
          const content = fs.readFileSync(cleanId, "utf-8");
          return `export default ${JSON.stringify(content)};`;
        }
      },
    },
  ],
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
