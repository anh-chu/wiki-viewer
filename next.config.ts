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
  // No route imports next/image, so the /_next/image optimizer is never
  // exercised. Declaring that here keeps it from lazily requiring sharp, which
  // postbuild deliberately excludes from the published tree: sharp's prebuilt
  // binary is platform-specific and publish is pack+tar with no install step,
  // so bundling it would lock the tarball to the publishing machine's OS/arch.
  images: {
    unoptimized: true,
  },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  // Extra origins allowed to hit the dev server (e.g. LAN IPs used to test
  // from another device). Override via NEXT_ALLOWED_DEV_ORIGINS, a
  // comma-separated list, without editing this file.
  allowedDevOrigins: process.env.NEXT_ALLOWED_DEV_ORIGINS
    ? process.env.NEXT_ALLOWED_DEV_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : ["devvm", "192.168.31.179"],
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
