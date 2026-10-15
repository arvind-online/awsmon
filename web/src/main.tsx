import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Only the Latin subset of Inter is needed; load it directly instead of every script subset.
const inter = new FontFace('Inter Variable', `url(${interLatin}) format('woff2')`, { weight: '100 900', display: 'swap' });
void inter.load().then((f) => document.fonts.add(f));

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
