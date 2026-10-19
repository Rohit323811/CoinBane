import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The PayPal toolkit and AI SDK are server-only; keep them out of the
  // client bundle graph entirely.
  serverExternalPackages: ["@paypal/agent-toolkit"],
};

export default nextConfig;
