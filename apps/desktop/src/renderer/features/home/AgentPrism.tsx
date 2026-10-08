import type { AgentState } from '@lnwjud/ipc-contracts';
import type { ReactElement } from 'react';

/** Dashboard reports idle for a connected agent that is ready for new work. */
export function AgentPrism(props: { readonly state: AgentState }): ReactElement {
  return <div className={`agent-prism ${props.state}`} data-testid="agent-state" aria-hidden="true">
    <svg className="agent-prism-art" viewBox="0 0 120 120" focusable="false">
      <defs>
        <linearGradient id="agent-prism-metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff9d5" />
          <stop offset=".24" stopColor="var(--prism-highlight)" />
          <stop offset=".63" stopColor="var(--prism-edge)" />
          <stop offset="1" stopColor="#242a38" />
        </linearGradient>
        <radialGradient id="agent-prism-light">
          <stop offset="0" stopColor="#fff" />
          <stop offset=".28" stopColor="var(--prism-highlight)" />
          <stop offset=".83" stopColor="var(--prism-core)" />
          <stop offset="1" stopColor="var(--prism-shadow)" />
        </radialGradient>
      </defs>
      <g className="agent-prism-orbits" fill="none">
        <ellipse cx="60" cy="60" rx="54" ry="24" stroke="var(--prism-edge)" strokeWidth="1" strokeDasharray="2 5" transform="rotate(-24 60 60)" />
        <circle cx="60" cy="60" r="52" stroke="var(--prism-edge)" strokeWidth=".7" strokeDasharray="1 7" opacity=".5" />
        <path d="M12 57 8 60 12 63M108 57 112 60 108 63" stroke="var(--prism-edge)" strokeWidth="1.7" />
      </g>
      <path d="M60 5 113 60 60 115 7 60Z" fill="#0c1421" stroke="var(--prism-edge)" strokeWidth="1.6" opacity=".88" />
      <path d="M60 12 106 60 60 108 14 60Z" fill="#1a2230" stroke="url(#agent-prism-metal)" strokeWidth="2.5" />
      <path d="M60 16 93 60 60 104 27 60Z" fill="var(--prism-shadow)" stroke="var(--prism-edge)" strokeWidth="1.6" />
      <path d="M60 16 93 60 60 45Z" fill="var(--prism-edge)" opacity=".48" />
      <path d="M60 16 27 60 60 45Z" fill="var(--prism-highlight)" opacity=".3" />
      <path d="M27 60 60 104 60 76Z" fill="var(--prism-edge)" opacity=".5" />
      <path d="M93 60 60 104 60 76Z" fill="var(--prism-shadow)" />
      <path d="M60 35 84 60 60 85 36 60Z" fill="url(#agent-prism-light)" stroke="var(--prism-highlight)" strokeWidth="1.5" />
      <path d="M60 37 82 60 60 54 38 60Z" fill="#fff" opacity=".22" />
      <path d="M38 60 60 83 60 54Z" fill="var(--prism-edge)" opacity=".24" />
      <path d="M82 60 60 83 60 54Z" fill="var(--prism-shadow)" opacity=".4" />
      <path d="M60 28V8M60 92v20M28 60H8M92 60h20" stroke="var(--prism-highlight)" strokeWidth="1" opacity=".65" />
      <circle cx="60" cy="60" r="4.5" fill="#fff" opacity=".74" />
    </svg>
  </div>;
}
