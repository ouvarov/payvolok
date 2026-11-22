import recessGroups from 'stylelint-config-recess-order/groups';

const SPACING = String.raw`/^(?:(?:0|auto|-?\$indent-[a-z0-9]+(?:\s*[*+-]\s*(?:\d+|\$indent-[a-z0-9]+))?|var\(--[a-z0-9-]+\)|env\([a-z-]+\)|calc\(.*(?:\$indent-|env\().*\))(?:\s+|$))+$/`;

export default {
  extends: ['stylelint-config-standard-scss', 'stylelint-config-css-modules'],
  plugins: ['stylelint-order', 'stylelint-plugin-use-baseline'],
  reportDescriptionlessDisables: true,
  reportNeedlessDisables: true,
  reportInvalidScopeDisables: true,
  rules: {
    'selector-class-pattern': '^[a-z][a-zA-Z0-9]*$',
    'selector-nested-pattern': String.raw`^&(:|\[data-)`,
    'max-nesting-depth': 3,
    'at-rule-disallowed-list': [['import', 'extend']],
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': [
      ['rgb', 'rgba', 'hsl', 'hsla', 'lighten', 'darken', 'rem', 'space'],
    ],
    'declaration-no-important': true,
    'property-disallowed-list': ['font-size', 'font-weight', 'line-height'],
    'media-feature-name-disallowed-list': ['min-width', 'max-width', 'width'],
    'selector-pseudo-class-disallowed-list': ['focus'],
    'declaration-property-value-disallowed-list': {
      display: ['flex', 'inline-flex'],
      outline: ['none', '0'],
    },
    'declaration-property-value-allowed-list': {
      'z-index': [String.raw`/^z\([a-z-]+\)$/`],
      [String.raw`/^(?:margin|padding)(?:-.+)?$|^(?:row-|column-)?gap$/`]: [
        SPACING,
      ],
    },
    'order/order': [
      [
        'dollar-variables',
        { type: 'at-rule', name: 'include', hasBlock: false },
        'custom-properties',
        'declarations',
        { type: 'rule', selector: '^&:[^:]', name: 'state' },
        { type: 'rule', selector: String.raw`^&\[data-`, name: 'data state' },
        { type: 'rule', selector: '^&::', name: 'pseudo-element' },
        { type: 'at-rule', name: 'include', hasBlock: true },
        { type: 'at-rule', name: 'media' },
        { type: 'at-rule', name: 'container' },
      ],
    ],
    'order/properties-order': [
      [{ properties: ['composes'] }, ...recessGroups],
      { unspecified: 'bottom' },
    ],
    'plugin/use-baseline': [
      true,
      {
        available: 'widely',
        severity: 'warning',
        ignoreAtRules: ['function'],
      },
    ],
  },
  overrides: [
    {
      files: ['src/styles/_themes-data.scss'],
      rules: { 'color-no-hex': null },
    },
    {
      files: [
        'src/styles/_shared.scss',
        'src/styles/_tokens.scss',
        'src/styles/global.scss',
      ],
      rules: {
        'property-disallowed-list': null,
        'declaration-property-value-disallowed-list': null,
        'declaration-property-value-allowed-list': null,
        'media-feature-name-disallowed-list': null,
      },
    },
  ],
};
