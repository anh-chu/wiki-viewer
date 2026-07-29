import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * decode-named-character-reference (pulled in by micromark, i.e. by every single
 * markdown render) declares a "browser" export that resolves to index.dom.js,
 * and that file runs document.createElement at MODULE scope. Bundled into a
 * prebuilt library, it makes importing this package throw
 * "ReferenceError: document is not defined" in ANY server environment, which in
 * Next means the host's page 500s while server-rendering a client component.
 *
 * Setting resolve.conditions is not enough: Vite re-adds "browser" for client
 * library builds. So resolve it normally and swap the file, which is safe
 * because index.js is isomorphic. It decodes with a lookup table instead of the
 * DOM and produces identical output.
 */
const isomorphicEntityDecode = {
  name: "wv-isomorphic-entity-decode",
  enforce: "pre" as const,
  async resolveId(source: string, importer: string | undefined, options: { isEntry: boolean }) {
    if (source !== "decode-named-character-reference") return null;
    // @ts-expect-error rollup plugin context is untyped in this narrow shim
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (!resolved) return null;
    return resolved.id.endsWith("index.dom.js")
      ? { ...resolved, id: resolved.id.replace(/index\.dom\.js$/, "index.js") }
      : resolved;
  },
};

export default defineConfig({
  plugins: [react(), isomorphicEntityDecode],

  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react-dom/client",
      ],
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
          "react/jsx-runtime": "jsxRuntime",
        },
      },
    },
  },
});
