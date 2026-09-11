import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, type Plugin } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import jsYaml from "js-yaml";
const parseYaml = jsYaml.load;
import { readFileSync } from "fs";

function yamlPlugin(): Plugin {
  return {
    name: "vite-plugin-yaml-inline",
    transform(_code, id) {
      if (!id.endsWith(".yaml") && !id.endsWith(".yml")) return;
      const raw = readFileSync(id, "utf8");
      const data = parseYaml(raw);
      return { code: `export default ${JSON.stringify(data)}`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ["buffer", "util", "stream", "events", "process"],
    }),
    yamlPlugin(),
    sveltekit(),
  ],
  optimizeDeps: {
    force: true,
    exclude: ["@rainlanguage/raindex"],
  },
  build: {
    target: "esnext",
  },
});
