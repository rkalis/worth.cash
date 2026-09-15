import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The HyperSync client is a native Node module, so it must never be bundled into the browser build.
  // It is only ever imported from route handlers under app/api.
  serverExternalPackages: ['@envio-dev/hypersync-client'],
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
