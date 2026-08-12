import type { ReactElement } from 'react';
import type { DashboardSnapshot } from '@lnwjud/ipc-contracts';

interface CapabilityPanelProps {
  readonly capabilities: DashboardSnapshot['capabilities'];
  readonly onLaunchManagedBrowser: () => Promise<void>;
  readonly browserBusy: boolean;
}

export function CapabilityPanel({ capabilities, onLaunchManagedBrowser, browserBusy }: CapabilityPanelProps): ReactElement {
  const readyCount = capabilities.filter((capability) => capability.available && capability.ready).length;
  const availableCount = capabilities.filter((capability) => capability.available).length;
  return (
    <section className="card capability-card" aria-label="Local computer capabilities">
      <div className="section-heading">
        <div>
          <p className="card-label">LOCAL COMPUTER ACCESS</p>
          <h2>7 MCP tools</h2>
        </div>
        <span>{readyCount}/7 ready · {availableCount}/7 available</span>
      </div>
      <div className="capability-grid">
        {capabilities.map((capability) => {
          const ready = capability.available && capability.ready;
          const available = capability.available;
          return (
            <article className="capability-row" key={capability.name}>
              <div>
                <strong>{capability.name}</strong>
                <p>{capability.title}</p>
                <small>{capability.description}</small>
                {capability.name === 'dom_cdp' && available && !ready ? (
                  <button
                    type="button"
                    disabled={browserBusy}
                    onClick={() => { void onLaunchManagedBrowser(); }}
                  >
                    {browserBusy ? 'Launching...' : 'Launch managed Chrome'}
                  </button>
                ) : null}
              </div>
              <span className={ready ? 'capability-ready' : available ? 'capability-available' : 'capability-unavailable'}>
                {ready ? 'READY' : available ? 'AVAILABLE' : 'UNAVAILABLE'}
              </span>
            </article>
          );
        })}
      </div>
    </section>
  );
}
