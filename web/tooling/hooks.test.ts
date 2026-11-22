import { describe, expect, it } from 'vitest';

import rootPackage from '../../package.json';
import webLintStaged from '../.lintstagedrc.json';

describe('git hooks', () => {
  it('runs the web check and tests before a push', () => {
    const prePush = rootPackage['simple-git-hooks']['pre-push'];

    expect(prePush).toContain('npm --prefix web run check');
    expect(prePush).toContain('npm --prefix web test');
  });

  it('lints staged web scripts with eslint and styles with stylelint', () => {
    expect(webLintStaged['*.{ts,tsx,mjs}']).toContain(
      'eslint --fix --max-warnings 0',
    );
    expect(webLintStaged['*.scss']).toContain(
      'stylelint --fix --max-warnings 0',
    );
  });
});
