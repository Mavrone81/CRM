import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output produces a self-contained .next/standalone/server.js
  // for a lean production Docker image.
  output: "standalone",
};

export default nextConfig;
