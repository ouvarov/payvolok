import { useEffect, useState } from 'react';

import { checkHealth } from '@/api/wake';

type WakeOutcome = 'ready' | 'slow' | 'error';
type WakePhase = 'checking' | 'waking' | WakeOutcome;

const ATTEMPT_TIMEOUT_MS = 20_000;
const NEXT_ATTEMPT_DELAY_MS = 2_000;
const WAKING_AFTER_MS = 3_000;
const SLOW_AFTER_MS = 90_000;
const MS_PER_SECOND = 1_000;

const getPhase = (
  outcome: WakeOutcome | null,
  elapsedMs: number,
  isRetry: boolean,
): WakePhase => {
  if (outcome) return outcome;
  return isRetry || elapsedMs >= WAKING_AFTER_MS ? 'waking' : 'checking';
};

const useWake = () => {
  const [cycle, setCycle] = useState(0);
  const [outcome, setOutcome] = useState<WakeOutcome | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const retry = () => {
    setOutcome(null);
    setElapsedMs(0);
    setCycle((current) => current + 1);
  };

  useEffect(() => {
    const startedAt = Date.now();
    let isActive = true;
    let attemptController: AbortController | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let nextAttemptTimer: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      isActive = false;
      attemptController?.abort();
      clearTimeout(abortTimer);
      clearTimeout(nextAttemptTimer);
      clearTimeout(slowTimer);
      clearInterval(ticker);
    };

    const finish = (result: WakeOutcome) => {
      stop();
      setOutcome(result);
    };

    const attempt = async () => {
      const controller = new AbortController();
      attemptController = controller;
      abortTimer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

      const check = await checkHealth(controller.signal);
      clearTimeout(abortTimer);
      if (!isActive) return;

      if (check === 'asleep') {
        nextAttemptTimer = setTimeout(
          () => void attempt(),
          NEXT_ATTEMPT_DELAY_MS,
        );
        return;
      }
      finish(check);
    };

    const ticker = setInterval(
      () => setElapsedMs(Date.now() - startedAt),
      MS_PER_SECOND,
    );
    const slowTimer = setTimeout(() => finish('slow'), SLOW_AFTER_MS);
    void attempt();

    return stop;
  }, [cycle]);

  return {
    phase: getPhase(outcome, elapsedMs, cycle > 0),
    elapsedSeconds: Math.floor(elapsedMs / MS_PER_SECOND),
    retry,
  };
};

export type { WakePhase };
export { useWake };
