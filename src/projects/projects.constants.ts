const PROJECT_STATUSES = ['active', 'archived'] as const;

const SEED_PROJECT_ID = '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a01';
const SEED_PROJECT_SLUG = 'payvolok-demo';
const SEED_PROJECT_NAME = 'PayVolok Demo';

type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export {
  PROJECT_STATUSES,
  SEED_PROJECT_ID,
  SEED_PROJECT_NAME,
  SEED_PROJECT_SLUG,
};
export type { ProjectStatus };
