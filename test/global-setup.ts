import './setup-env';

import { applyMigrations } from './apply-migrations';

export default async (): Promise<void> => {
  await applyMigrations(process.env.E2E_DATABASE_URL as string);
};
