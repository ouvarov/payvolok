import type { FC } from 'react';

import { SandboxBanner } from '@/components/SandboxBanner/SandboxBanner';
import { WakeGate } from '@/components/WakeGate/WakeGate';

import styles from './DemoPage.module.scss';

const DemoPage: FC = () => (
  <>
    <SandboxBanner />
    <main className={styles.page}>
      <h1 className={styles.wordmark}>
        <span className={styles.pay}>Pay</span>Volok
      </h1>
      <p className={styles.intro}>
        One API over many payment providers. The test payment form arrives here
        next.
      </p>
      <WakeGate>
        <button type="button" className={styles.create}>
          Create payment
        </button>
      </WakeGate>
    </main>
  </>
);

export { DemoPage };
