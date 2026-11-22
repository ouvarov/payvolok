import eslintReact from '@eslint-react/eslint-plugin';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y-x';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NATIVE_BOOLEAN_NAMES =
  '^(disabled|checked|required|readOnly|multiple|open|hidden|selected|autoFocus)$';

export default defineConfig([
  globalIgnores(['dist', 'coverage']),
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'typeLike', format: ['PascalCase'] },
        {
          selector: 'typeAlias',
          format: ['PascalCase'],
          custom: { regex: '^I[A-Z]|Types?$', match: false },
        },
        {
          selector: ['variable', 'parameter', 'typeProperty'],
          types: ['boolean'],
          format: ['PascalCase'],
          prefix: ['is', 'has'],
          filter: { regex: NATIVE_BOOLEAN_NAMES, match: false },
        },
      ],
      'func-style': ['error', 'expression'],
      'id-denylist': ['error', 'e', 'res', 'err', 'cb'],
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            [String.raw`^\u0000`],
            ['^react', String.raw`^@?\w`],
            ['^@/'],
            [String.raw`^\.(?!.*\.module\.scss$)`],
            [String.raw`\.module\.scss$`],
          ],
        },
      ],
      'simple-import-sort/exports': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      eslintReact.configs['recommended-type-checked'],
      jsxA11y.configs.recommended,
    ],
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/exhaustive-deps': 'error',
      '@eslint-react/dom-no-missing-button-type': 'error',
      'no-restricted-exports': [
        'error',
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
            namedFrom: true,
            namespaceFrom: true,
          },
        },
      ],
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../*'], message: 'Use the @/ alias.' }] },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'FunctionDeclaration[id.name=/^[A-Z][a-z]/]',
          message: 'R1: const X: FC<Props> = ...',
        },
        {
          selector:
            'VariableDeclarator[id.name=/^[A-Z][a-z]/][init.type=/^(Arrow)?FunctionExpression$/]:not([id.typeAnnotation.typeAnnotation.typeName.name="FC"])',
          message: 'R1: type components with FC',
        },
        {
          selector:
            'ExportNamedDeclaration[declaration.type="VariableDeclaration"], ExportNamedDeclaration[declaration.type="FunctionDeclaration"]',
          message: 'R1: export { X } at the bottom',
        },
        {
          selector: 'JSXAttribute[name.name="style"]',
          message: 'The page CSP blocks inline styles; use a class.',
        },
        {
          selector: 'CallExpression[callee.name="forwardRef"]',
          message: 'R7: ref is a plain prop',
        },
        {
          selector: 'JSXMemberExpression[property.name="Provider"]',
          message: 'R13: <Context value>',
        },
      ],
    },
  },
  {
    files: ['vite.config.ts', 'tooling/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  prettier,
]);
