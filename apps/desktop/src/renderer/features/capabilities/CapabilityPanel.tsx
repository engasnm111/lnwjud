import type { ReactElement } from 'react';
import type { DashboardSnapshot } from '@lnwjud/ipc-contracts';

interface CapabilityPanelProps {
  readonly capabilities: DashboardSnapshot['capabilities'];
}

export function CapabilityPanel({ capabilities }: CapabilityPanelProps): ReactElement {
  return (
    <section className="card capability-card" aria-label="Local computer capabilities">
      <div className="section-heading">
        <div>
          <p className="card-label">LOCAL COMPUTER ACCESS</p>
          <h2>7 MCP tools</h2>
        </div>
        <span>{capabilities.filter((capability) => capability.available && capability.ready).length}/7 ready</span>
      </div>
      <div className="capability-grid">
        {capabilities.map((capability) => {
          const ready = capability.available && capability.ready;
          return (
            <article className="capability-row" key={capability.name}>
              <div>
                <strong>{capability.name}</strong>
                <p>{capability.title}</p>
                <small>{capability.description}</small>
              </div>
              <span className={ready ? 'capability-ready' : 'capability-unavailable'}>{ready ? 'READY' : 'UNAVAILABLE'}</span>
            </article>
          );
        })}
      </div>
    </section>
  );
}
