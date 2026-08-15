import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { StandaloneLogViewer } from './features/live/StandaloneLogViewer.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Renderer root is missing');

const isLogViewer = window.location.hash === '#log-viewer';

createRoot(root).render(
  <StrictMode>
    {isLogViewer ? <StandaloneLogViewer /> : <App />}
  </StrictMode>,
);
