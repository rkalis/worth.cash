import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The HyperSync client is a native Node module, so it must never be bundled into the browser build.
  // It is only ever imported from route handlers under app/api.
  serverExternalPackages: ['@envio-dev/hypersync-client'],
  images: {
    // NFT artwork comes from arbitrary IPFS gateways and collection-hosted CDNs, so we cannot enumerate hosts.
    // We proxy and sanitise these URLs ourselves in lib/nfts/media.ts instead.
    unoptimized: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
