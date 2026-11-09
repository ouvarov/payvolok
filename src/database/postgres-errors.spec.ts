import { DrizzleQueryError } from 'drizzle-orm';

import {
  describeError,
  isPermanentDataError,
  isUniqueViolationOf,
  postgresCodeOf,
} from './postgres-errors';

const LEAK_MARKER = 'LEAKMARKER';

const queryErrorWithCode = (code: string): DrizzleQueryError =>
  new DrizzleQueryError(
    `insert ${LEAK_MARKER}`,
    [LEAK_MARKER],
    Object.assign(new Error(LEAK_MARKER), {
      code,
      constraint_name: 'some_constraint',
    }),
  );

describe('postgresCodeOf', () => {
  it('reads the code of the wrapped driver error', () => {
    expect(postgresCodeOf(queryErrorWithCode('22021'))).toBe('22021');
  });

  it.each([
    ['a plain error', new Error('22021')],
    ['a string', '22021'],
    ['null', null],
  ])('returns null for %s', (_case, error) => {
    expect(postgresCodeOf(error)).toBeNull();
  });
});

describe('isPermanentDataError', () => {
  it.each(['22021', '22P02', '22003', '23514'])('is true for %s', (code) => {
    expect(isPermanentDataError(queryErrorWithCode(code))).toBe(true);
  });

  it.each(['23505', '23503', '40001', '57014', '08006', '42P01'])(
    'is false for %s',
    (code) => {
      expect(isPermanentDataError(queryErrorWithCode(code))).toBe(false);
    },
  );

  it('is false for an error with no pg code', () => {
    expect(isPermanentDataError(new Error('22021'))).toBe(false);
  });
});

describe('isUniqueViolationOf', () => {
  it('matches only the named constraint', () => {
    const error = queryErrorWithCode('23505');

    expect(isUniqueViolationOf(error, 'some_constraint')).toBe(true);
    expect(isUniqueViolationOf(error, 'other_constraint')).toBe(false);
  });
});

describe('describeError', () => {
  it('gives the class and the pg code without the message or params', () => {
    const description = describeError(queryErrorWithCode('22021'));

    expect(description).toBe('DrizzleQueryError 22021');
    expect(description).not.toContain(LEAK_MARKER);
  });

  it('gives only the class of an error with no pg code', () => {
    expect(describeError(new TypeError(LEAK_MARKER))).toBe('TypeError');
  });

  it('describes a thrown non-error as unknown', () => {
    expect(describeError(LEAK_MARKER)).toBe('unknown');
  });
});
