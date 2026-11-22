import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoPage } from '@/pages/DemoPage/DemoPage';
import type { HealthAnswer } from '@/test/healthFakes';
import { fakeHealth } from '@/test/healthFakes';

const renderPageAfter = async (ms: number, ...answers: HealthAnswer[]) => {
  fakeHealth(...answers);
  render(<DemoPage />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const sandboxBanner = () =>
  screen.getByRole('complementary', { name: 'Sandbox notice' });

describe('DemoPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<[string, number, HealthAnswer[]]>([
    ['while checking', 0, ['hang']],
    ['while waking', 3_000, ['asleep']],
    ['when slow', 90_000, ['asleep']],
    ['after an error', 0, ['error']],
    ['when ready', 0, ['ready']],
  ])(
    'shows the sandbox banner without a close control %s',
    async (_state, ms, answers) => {
      await renderPageAfter(ms, ...answers);

      expect(sandboxBanner()).toHaveTextContent(
        'Sandbox only, no real money. Never enter a real card. Use any email such as test@example.com.',
      );
      expect(within(sandboxBanner()).queryByRole('button')).toBeNull();
    },
  );

  it('keeps Create payment disabled until the server is ready', async () => {
    await renderPageAfter(3_000, 'asleep', 'asleep', 'ready');

    expect(
      screen.getByRole('button', { name: 'Create payment' }),
    ).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(
      screen.getByRole('button', { name: 'Create payment' }),
    ).toBeEnabled();
  });
});
