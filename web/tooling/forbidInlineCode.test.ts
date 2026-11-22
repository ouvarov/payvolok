import { describe, expect, it } from 'vitest';

import { findInlineCode } from './forbidInlineCode';

const page = (head: string, body = '<div id="root"></div>') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('findInlineCode', () => {
  it('accepts a page that only links its script and styles', () => {
    const html = page(
      '<script type="module" crossorigin src="/assets/index-a1.js"></script><link rel="stylesheet" href="/assets/index-b2.css">',
    );

    expect(findInlineCode(html)).toEqual([]);
  });

  it('finds an inline script', () => {
    const html = page('<script>window.theme = "dark"</script>');

    expect(findInlineCode(html)).toEqual(['inline <script>']);
  });

  it('finds a style element', () => {
    expect(findInlineCode(page('<style>body{margin:0}</style>'))).toEqual([
      '<style> element',
    ]);
  });

  it('finds a style attribute', () => {
    const html = page('', '<div id="root" style="color: red"></div>');

    expect(findInlineCode(html)).toEqual(['style= attribute']);
  });

  it('finds an inline event handler', () => {
    const html = page('', '<img src="/a.png" onerror="alert(1)">');

    expect(findInlineCode(html)).toEqual(['on*= handler attribute']);
  });
});
