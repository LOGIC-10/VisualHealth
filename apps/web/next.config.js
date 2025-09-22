/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    // Aggressive caching for static assets served by Next.js
    return [
      {
        source: '/_next/static/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }
        ]
      },
      {
        source: '/images/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }
        ]
      }
    ];
  },
  async rewrites() {
    // Single-port deployment: proxy API paths to internal services under /api/* to avoid clashing with Next pages.
    return [
      { source: '/api/auth/:path*', destination: 'http://auth-service:4001/:path*' },
      { source: '/api/media/:path*', destination: 'http://media-service:4003/:path*' },
      { source: '/api/analysis/:path*', destination: 'http://analysis-service:4004/:path*' },
      { source: '/api/feed/:path*', destination: 'http://feed-service:4005/:path*' },
      { source: '/api/viz/:path*', destination: 'http://viz-service:4006/:path*' },
      { source: '/api/llm/:path*', destination: 'http://llm-service:4007/:path*' }
    ];
  }
};
module.exports = nextConfig;
