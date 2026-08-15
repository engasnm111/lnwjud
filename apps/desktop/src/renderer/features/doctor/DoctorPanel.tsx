import type { ReactElement } from 'react';
import type { DoctorReport } from '@lnwjud/ipc-contracts';

interface DoctorPanelProps {
  readonly report: DoctorReport | null;
  readonly onRunDoctor: () => Promise<void>;
}

export function DoctorPanel({ report, onRunDoctor }: DoctorPanelProps): ReactElement {
  return (
    <section className="panel">
      <button type="button" onClick={() => { void onRunDoctor(); }}>Run doctor</button>
      {report === null ? <p>No report yet.</p> : (
        <div className="doctor-list">
          {report.checks.map((check) => (
            <article key={check.id} data-testid={`doctor-check-${check.id}`} className={`doctor-check doctor-${check.status}`}>
              <div><strong>{check.id}</strong><span>{check.status}</span></div>
              <p>{check.message}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
