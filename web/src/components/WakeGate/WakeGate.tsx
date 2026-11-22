import type { FC, ReactNode } from 'react';
import { useRef } from 'react';

import type { WakePhase } from '@/hooks/useWake';
import { useWake } from '@/hooks/useWake';

import styles from './WakeGate.module.scss';

type WakeGateProps = {
  children: ReactNode;
};

type Notice = {
  title: string;
  text: string;
  hasRetry: boolean;
};

const NOTICE_BY_PHASE = {
  checking: null,
  ready: null,
  waking: {
    title: 'The demo server is waking up.',
    text: 'Free hosting puts it to sleep when idle.',
    hasRetry: false,
  },
  slow: {
    title: 'Taking longer than usual.',
    text: 'The demo server has not answered yet.',
    hasRetry: true,
  },
  error: {
    title: 'The demo server answered with an error.',
    text: 'Try again in a minute.',
    hasRetry: true,
  },
} satisfies Record<WakePhase, Notice | null>;

const SECONDS_PER_MINUTE = 60;

const formatElapsed = (seconds: number): string => {
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const restSeconds = String(seconds % SECONDS_PER_MINUTE).padStart(2, '0');
  return `${minutes}:${restSeconds}`;
};

const WakeGate: FC<WakeGateProps> = ({ children }) => {
  const { phase, elapsedSeconds, retry } = useWake();
  const statusRef = useRef<HTMLDivElement>(null);

  const notice: Notice | null = NOTICE_BY_PHASE[phase];
  const isReady = phase === 'ready';

  const handleRetry = () => {
    statusRef.current?.focus();
    retry();
  };

  return (
    <div className={styles.gate}>
      <div
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className={notice ? styles.panel : undefined}
      >
        {notice && (
          <>
            <p className={styles.title}>{notice.title}</p>
            <p className={styles.text}>{notice.text}</p>
            {phase === 'waking' && (
              <div className={styles.progress} aria-hidden="true">
                <span className={styles.track}>
                  <span className={styles.dot} />
                </span>
                <span className={styles.elapsed}>
                  {formatElapsed(elapsedSeconds)} · usually ~1 min
                </span>
              </div>
            )}
            {notice.hasRetry && (
              <button
                type="button"
                className={styles.retry}
                onClick={handleRetry}
              >
                Retry
              </button>
            )}
          </>
        )}
      </div>
      <fieldset className={styles.controls} disabled={!isReady}>
        {children}
      </fieldset>
    </div>
  );
};

export { WakeGate };
