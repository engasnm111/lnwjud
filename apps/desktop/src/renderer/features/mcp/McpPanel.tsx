import { useEffect, useState, type ReactElement } from 'react';
import type { DashboardSnapshot, WorkspaceSummary } from '@lnwjud/ipc-contracts';

interface McpPanelProps {
  readonly status: DashboardSnapshot['mcp'];
  readonly selectedWorkspace: WorkspaceSummary | null;
  readonly onStart: () => Promise<void>;
  readonly onStop: () => Promise<void>;
}

export function McpPanel({ status, selectedWorkspace, onStart, onStop }: McpPanelProps): ReactElement {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  useEffect(() => {
    setCopyStatus(null);
  }, [status.url]);

  async function copyEndpoint(): Promise<void> {
    if (status.url === null) return;
    try {
      await copyText(status.url);
      setCopyStatus('Copied');
    } catch {
      setCopyStatus('Copy failed; select the endpoint manually');
    }
  }

  return (
    <section className="card mcp-card" aria-label="MCP connection">
      <div className="section-heading">
        <h2>MCP connection</h2>
        <span>{selectedWorkspace?.displayName ?? 'No workspace selected'}</span>
      </div>
      <div className="mcp-status-row">
        <div>
          <p className="card-label">Local status</p>
          <strong data-testid="mcp-status">{status.running ? 'Running' : 'Stopped'}</strong>
        </div>
        <div className="mcp-actions">
          <button
            type="button"
            disabled={status.running || selectedWorkspace === null}
            onClick={() => { void onStart(); }}
          >
            Start Connection
          </button>
          <button type="button" disabled={!status.running} onClick={() => { void onStop(); }}>
            Stop Connection
          </button>
        </div>
      </div>
      <p className="mcp-endpoint-label">MCP endpoint</p>
      <code data-testid="mcp-endpoint" className="mcp-endpoint">{status.url ?? 'No local endpoint active'}</code>
      <div className="mcp-copy-row">
        <button type="button" disabled={status.url === null} onClick={() => { void copyEndpoint(); }}>
          Copy MCP endpoint
        </button>
        {copyStatus === null ? null : <span data-testid="mcp-copy-status" role="status">{copyStatus}</span>}
      </div>
    </section>
  );
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', 'true');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Clipboard is unavailable');
}
