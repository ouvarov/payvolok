import '@/styles/global.scss';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { DemoPage } from '@/pages/DemoPage/DemoPage';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <DemoPage />
  </StrictMode>,
);
