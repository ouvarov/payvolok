import type { FC } from 'react';

import styles from './SandboxBanner.module.scss';

const SandboxBanner: FC = () => (
  <aside className={styles.banner} aria-label="Sandbox notice">
    <p>
      <strong className={styles.label}>Sandbox only, no real money.</strong>{' '}
      Never enter a real card. Use any email such as test@example.com.
    </p>
  </aside>
);

export { SandboxBanner };
