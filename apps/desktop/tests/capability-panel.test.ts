import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DashboardSnapshot } from '@lnwjud/ipc-contracts';
import { CapabilityPanel } from '../src/renderer/features/capabilities/CapabilityPanel.js';

const capabilities: DashboardSnapshot['capabilities'] = [
  { name: 'shell', title: 'Shell', description: 'Shell', available: true, ready: true },
  { name: 'dom_cdp', title: 'Browser', description: 'Browser', available: true, ready: false },
  { name: 'accessibility', title: 'Accessibility', description: 'Accessibility', available: true, ready: true },
  { name: 'input_event', title: 'Input', description: 'Input', available: true, ready: true },
  { name: 'vision', title: 'Vision', description: 'Vision', available: true, ready: true },
  { name: 'window', title: 'Window', description: 'Window', available: true, ready: true },
  { name: 'health', title: 'Health', description: 'Health', available: true, ready: true },
];

describe('CapabilityPanel', () => {
  it('shows an available browser and offers to launch its managed session', () => {
    const markup = renderToStaticMarkup(createElement(CapabilityPanel, {
      capabilities,
      browserBusy: false,
      onLaunchManagedBrowser: async () => {},
    }));

    expect(markup).toContain('AVAILABLE');
    expect(markup).toContain('Launch managed Chrome');
    expect(markup).toContain('6/7 ready');
  });
});
