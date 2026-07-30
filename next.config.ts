import type { NextConfig } from "next";
import path from "node:path";

import pkg from "./package.json" with { type: "json" };

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  // Pin tracing root to this repo so a stray lockfile in a parent dir (e.g.
  // ~/package-lock.json) can't make Next nest the standalone output under a
  // subdir and break the `server.js` location the publish prepack checks.
  outputFileTracingRoot: path.resolve(__dirname),
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  allowedDevOrigins: ['devvm'],
  // Block framing on all routes by default. Same-origin framing for nested
  // /api/assets and /api/app-proxy iframes still works because the host is now
  // same-origin (X-Frame-Options: SAMEORIGIN permits same-origin ancestors).
  headers: async () => [
    {
      source: "/(.*)",
      headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
    },
  ],
};

export default nextConfig;
