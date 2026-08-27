import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { StandaloneLogViewer } from './features/live/StandaloneLogViewer.js';
import './styles.css';
import './settings-extra.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Renderer root is missing');

const rendererPlatform = /Macintosh|Mac OS X/i.test(navigator.userAgent)
  ? 'macos'
  : /Windows/i.test(navigator.userAgent)
    ? 'windows'
    : 'other';
document.documentElement.dataset.platform = rendererPlatform;

const isLogViewer = window.location.hash === '#log-viewer';

createRoot(root).render(
  <StrictMode>
    {isLogViewer ? <StandaloneLogViewer /> : <App />}
  </StrictMode>,
);
