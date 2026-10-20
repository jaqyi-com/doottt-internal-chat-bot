/** @type {import('next').NextConfig} */
const nextConfig = {
  // Native / node-only packages stay out of the bundle.
  serverExternalPackages: ["pg", "@libsql/client", "libsql"],
  // The agent reads the system prompt from disk at runtime; ship it with the functions.
  outputFileTracingIncludes: {
    "/api/**": ["./prompts/**"],
  },
};

export default nextConfig;
