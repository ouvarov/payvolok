import { requestOf } from './create-api-key';

describe('create-api-key arguments', () => {
  it('reads the project slug, the name and the expiry', () => {
    expect(
      requestOf([
        '--project',
        'payvolok-demo',
        '--name',
        'render production',
        '--expires-in-days',
        '30',
      ]),
    ).toEqual({
      projectSlug: 'payvolok-demo',
      name: 'render production',
      expiresInDays: 30,
    });
  });

  it('leaves a key without --expires-in-days unexpiring', () => {
    expect(
      requestOf(['--project', 'payvolok-demo', '--name', 'local']),
    ).toMatchObject({ expiresInDays: null });
  });

  it.each([
    ['no project', ['--name', 'local']],
    ['no name', ['--project', 'payvolok-demo']],
  ])('refuses %s', (_case, args) => {
    expect(() => requestOf(args)).toThrow(
      'Usage: --project <slug> --name <label> [--expires-in-days N]',
    );
  });

  it.each(['0', '1.5', 'soon'])('refuses --expires-in-days %s', (days) => {
    expect(() =>
      requestOf([
        '--project',
        'payvolok-demo',
        '--name',
        'local',
        '--expires-in-days',
        days,
      ]),
    ).toThrow('--expires-in-days must be a whole number of days, 1 or more');
  });
});
