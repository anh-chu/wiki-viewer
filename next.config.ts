import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin tracing root to this repo so a stray lockfile in a parent dir (e.g.
  // ~/package-lock.json) can't make Next nest the standalone output under a
  // subdir and break the `server.js` location the publish prepack checks.
  outputFileTracingRoot: path.resolve(__dirname),
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  allowedDevOrigins: ['devvm']
};

export default nextConfig;
