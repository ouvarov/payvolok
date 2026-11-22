import type { Plugin } from 'vite';

const INLINE_CODE_PATTERNS = [
  { name: 'inline <script>', pattern: /<script(?![^>]*\ssrc=)[^>]*>/i },
  { name: '<style> element', pattern: /<style[\s>]/i },
  { name: 'style= attribute', pattern: /<[^>]*\sstyle=/i },
  { name: 'on*= handler attribute', pattern: /<[^>]*\son[a-z]+=/i },
];

const findInlineCode = (html: string): string[] =>
  INLINE_CODE_PATTERNS.filter(({ pattern }) => pattern.test(html)).map(
    ({ name }) => name,
  );

const forbidInlineCode = (): Plugin => ({
  name: 'payvolok:forbid-inline-code',
  apply: 'build',
  writeBundle(_options, bundle) {
    const page = bundle['index.html'];
    if (page?.type !== 'asset') return this.error('index.html was not emitted');

    const html =
      typeof page.source === 'string'
        ? page.source
        : new TextDecoder().decode(page.source);
    const found = findInlineCode(html);
    if (found.length > 0) {
      this.error(
        `index.html breaks the page CSP with: ${found.join(', ')}. Move it into a file.`,
      );
    }
  },
});

export { findInlineCode, forbidInlineCode };
