import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // mysql2 chạy phía server (Node), không bundle
  serverExternalPackages: ['mysql2'],
};

export default nextConfig;
