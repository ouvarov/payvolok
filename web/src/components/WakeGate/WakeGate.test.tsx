import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WakeGate } from '@/components/WakeGate/WakeGate';
import type { HealthAnswer } from '@/test/healthFakes';
import { fakeHealth } from '@/test/healthFakes';

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const renderGate = (...answers: HealthAnswer[]) => {
  fakeHealth(...answers);
  render(
    <WakeGate>
      <button type="button">Create payment</button>
    </WakeGate>,
  );
};

const createButton = () =>
  screen.getByRole('button', { name: 'Create payment' });

describe('WakeGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows nothing during the first 3 s and keeps its children disabled', async () => {
    renderGate('asleep');

    await advance(2_999);

    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(createButton()).toBeDisabled();
  });

  it('shows the waking panel with the elapsed time after 3 s', async () => {
    renderGate('asleep');

    await advance(3_000);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('The demo server is waking up.');
    expect(status).toHaveTextContent('0:03 · usually ~1 min');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('counts minutes in the elapsed time', async () => {
    renderGate('asleep');

    await advance(65_000);

    expect(screen.getByRole('status')).toHaveTextContent('1:05');
  });

  it('says it is taking longer than usual after 90 s and offers Retry', async () => {
    renderGate('asleep');

    await advance(90_000);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Taking longer than usual.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(createButton()).toBeDisabled();
  });

  it('starts waking again on Retry and keeps focus in the panel', async () => {
    renderGate('asleep');
    await advance(90_000);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('The demo server is waking up.');
    expect(status).toHaveFocus();
  });

  it('enables its children and hides the panel once the server is ready', async () => {
    renderGate('asleep', 'asleep', 'ready');

    await advance(4_000);

    expect(createButton()).toBeEnabled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('offers Retry when the server answers with an error', async () => {
    renderGate('error');

    await advance(0);

    expect(screen.getByRole('status')).toHaveTextContent(
      'The demo server answered with an error.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });
});
