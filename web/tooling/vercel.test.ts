import { describe, expect, it } from 'vitest';

import vercelConfig from '../vercel.json';

const API_ORIGIN = 'https://payvolok-api.onrender.com';

const pageHeader = (key: string) =>
  vercelConfig.headers
    .find(({ source }) => source === '/((?!api/).*)')
    ?.headers.find((header) => header.key === key)?.value;

const cspDirective = (name: string) =>
  pageHeader('Content-Security-Policy')
    ?.split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith(`${name} `));

describe('vercel.json', () => {
  it('rewrites the health check to the API readiness probe before other API paths', () => {
    expect(vercelConfig.rewrites).toEqual([
      { source: '/api/health', destination: `${API_ORIGIN}/health/ready` },
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
    ]);
  });

  it('lets the page connect only to its own origin', () => {
    expect(cspDirective('connect-src')).toBe("connect-src 'self'");
  });

  it('allows scripts and styles only from files on its own origin', () => {
    expect(cspDirective('script-src')).toBe("script-src 'self'");
    expect(cspDirective('style-src')).toBe("style-src 'self'");
    expect(JSON.stringify(vercelConfig)).not.toContain('unsafe-inline');
  });
});
