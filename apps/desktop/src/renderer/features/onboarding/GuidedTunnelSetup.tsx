import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  EXTERNAL_SETUP_URLS,
  type ExternalSetupTarget,
  type TunnelStatus,
  type UiLocale,
} from '@lnwjud/ipc-contracts';
import { copyTextToClipboard } from '../../clipboard.js';
import { createTranslator } from '../../i18n/index.js';
import {
  initialGuidedTunnelStep,
  isTunnelRunning,
  type GuidedTunnelStep,
} from './guided-tunnel-setup-state.js';

interface GuidedTunnelSetupProps {
  readonly locale: UiLocale;
  readonly tunnel: TunnelStatus;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenExternal: (target: ExternalSetupTarget) => Promise<void>;
  readonly onSaveApiKey: (apiKey: string) => Promise<void>;
  readonly onConfigureProfile: (tunnelId: string) => Promise<string>;
  readonly onStartTunnel: () => Promise<TunnelStatus>;
  readonly onRefresh: () => Promise<void>;
  readonly onLocalComplete: () => void;
}

type BusyAction = 'save_key' | 'configure' | 'start' | null;

const TUNNEL_ID_PATTERN = /^tunnel_[A-Za-z0-9_-]{8,128}$/;
const STEPS: readonly GuidedTunnelStep[] = ['create_tunnel', 'save_key', 'configure', 'start', 'connect_chatgpt'];

export function GuidedTunnelSetup(props: GuidedTunnelSetupProps): ReactElement | null {
  const t = createTranslator(props.locale);
  const [step, setStep] = useState<GuidedTunnelStep>(() => initialGuidedTunnelStep(props.tunnel));
  const [tunnelId, setTunnelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkErrorTarget, setLinkErrorTarget] = useState<ExternalSetupTarget | null>(null);
  const previousOpen = useRef(false);
  const completionReported = useRef(false);

  useEffect(() => {
    if (props.open && !previousOpen.current) {
      setStep(initialGuidedTunnelStep(props.tunnel));
      setError(null);
      setNotice(null);
      setLinkErrorTarget(null);
      setApiKey('');
      setShowApiKey(false);
      completionReported.current = false;
    }
    previousOpen.current = props.open;
  }, [props.open, props.tunnel]);

  useEffect(() => {
    if (!props.open || !isTunnelRunning(props.tunnel)) return;
    setStep('connect_chatgpt');
    if (completionReported.current) return;
    completionReported.current = true;
    props.onLocalComplete();
  }, [props.open, props.tunnel, props.onLocalComplete]);

  if (!props.open) return null;

  const stepIndex = STEPS.indexOf(step);
  const canStart = props.tunnel.hasApiKey && props.tunnel.profileExists && busyAction === null;

  function close(): void {
    setApiKey('');
    setShowApiKey(false);
    setError(null);
    props.onOpenChange(false);
  }

  async function openExternal(target: ExternalSetupTarget): Promise<void> {
    setLinkErrorTarget(null);
    try {
      await props.onOpenExternal(target);
    } catch {
      setLinkErrorTarget(target);
    }
  }

  function continueFromTunnelId(): void {
    const normalized = tunnelId.trim();
    if (!props.tunnel.profileExists && !TUNNEL_ID_PATTERN.test(normalized)) {
      setError(t('guidedTunnel.tunnelIdInvalid'));
      return;
    }
    setError(null);
    setStep(props.tunnel.hasApiKey ? 'configure' : 'save_key');
  }

  async function saveApiKey(): Promise<void> {
    const normalized = apiKey.trim();
    if (normalized.length === 0) {
      setError(t('guidedTunnel.apiKeyRequired'));
      return;
    }
    setBusyAction('save_key');
    setError(null);
    setNotice(null);
    try {
      await props.onSaveApiKey(normalized);
      setApiKey('');
      setShowApiKey(false);
      await props.onRefresh();
      setNotice(t('guidedTunnel.keyStored'));
      setStep(props.tunnel.profileExists ? 'start' : 'configure');
    } catch (cause: unknown) {
      setError(safeErrorMessage(cause, t('guidedTunnel.retry')));
    } finally {
      setBusyAction(null);
    }
  }

  async function configureProfile(): Promise<void> {
    const normalized = tunnelId.trim();
    if (!props.tunnel.profileExists && !TUNNEL_ID_PATTERN.test(normalized)) {
      setError(t('guidedTunnel.tunnelIdInvalid'));
      return;
    }
    setBusyAction('configure');
    setError(null);
    setNotice(t('guidedTunnel.configuring'));
    try {
      if (!props.tunnel.profileExists) await props.onConfigureProfile(normalized);
      await props.onRefresh();
      setNotice(t('guidedTunnel.configured'));
      setStep('start');
    } catch (cause: unknown) {
      setNotice(null);
      setError(safeErrorMessage(cause, t('guidedTunnel.retry')));
    } finally {
      setBusyAction(null);
    }
  }

  async function startTunnel(): Promise<void> {
    if (!props.tunnel.hasApiKey || !props.tunnel.profileExists) return;
    setBusyAction('start');
    setError(null);
    setNotice(t('guidedTunnel.starting'));
    try {
      const status = await props.onStartTunnel();
      await props.onRefresh();
      if (!isTunnelRunning(status)) {
        setNotice(null);
        setError(status.message?.trim() || (status.source === 'external' ? t('guidedTunnel.externalRuntime') : t('guidedTunnel.retry')));
        return;
      }
      setNotice(t('guidedTunnel.running'));
      setStep('connect_chatgpt');
      completionReported.current = true;
      props.onLocalComplete();
    } catch (cause: unknown) {
      setNotice(null);
      setError(safeErrorMessage(cause, t('guidedTunnel.retry')));
    } finally {
      setBusyAction(null);
    }
  }

  function goBack(): void {
    setError(null);
    setNotice(null);
    if (step === 'save_key') setStep('create_tunnel');
    else if (step === 'configure') setStep(props.tunnel.hasApiKey ? 'create_tunnel' : 'save_key');
    else if (step === 'start') setStep(props.tunnel.profileExists ? (props.tunnel.hasApiKey ? 'create_tunnel' : 'save_key') : 'configure');
    else if (step === 'connect_chatgpt') setStep('start');
  }

  const fallbackUrl = linkErrorTarget === null ? null : EXTERNAL_SETUP_URLS[linkErrorTarget];

  return (
    <div className="guided-tunnel-panel" data-testid="guided-tunnel-setup">
      <div className="guided-tunnel-panel-header">
        <div>
          <span className="settings-eyebrow">OPENAI SECURE MCP TUNNEL</span>
          <h3>{t('guidedTunnel.openGuide')}</h3>
          <p>{t('guidedTunnel.privacy')}</p>
        </div>
        <button type="button" className="guided-tunnel-close" aria-label={t('guidedTunnel.later')} onClick={close}>×</button>
      </div>

      <ol className="guided-tunnel-progress" aria-label={t('guidedTunnel.progress')}>
        {STEPS.map((candidate, index) => (
          <li key={candidate} className={index < stepIndex ? 'is-complete' : index === stepIndex ? 'is-current' : ''}>
            <span>{index < stepIndex ? '✓' : index + 1}</span>
            <small>{progressLabel(candidate, t)}</small>
          </li>
        ))}
      </ol>

      <div className="guided-tunnel-step" aria-live="polite">
        {step === 'create_tunnel' ? (
          <>
            <StepHeading title={t('guidedTunnel.stepTunnelTitle')} body={t('guidedTunnel.stepTunnelBody')} />
            <button type="button" onClick={() => { void openExternal('openai_tunnels'); }}>{t('guidedTunnel.openTunnelSettings')}</button>
            <label className="field-label" htmlFor="guided-tunnel-id">{t('guidedTunnel.tunnelIdLabel')}</label>
            <input
              id="guided-tunnel-id"
              name="tunnelId"
              type="text"
              value={tunnelId}
              placeholder="tunnel_0123456789abcdef"
              autoComplete="off"
              onChange={(event) => setTunnelId(event.target.value)}
            />
            <p className="hint">{props.tunnel.profileExists ? t('guidedTunnel.configured') : t('guidedTunnel.tunnelIdHint')}</p>
            <div className="inline-actions">
              <button type="button" className="btn-save-gold" onClick={continueFromTunnelId}>{t('guidedTunnel.next')}</button>
            </div>
          </>
        ) : null}

        {step === 'save_key' ? (
          <>
            <StepHeading title={t('guidedTunnel.stepKeyTitle')} body={t('guidedTunnel.stepKeyBody')} />
            <button type="button" onClick={() => { void openExternal('openai_api_keys'); }}>{t('guidedTunnel.openApiKeys')}</button>
            <label className="field-label" htmlFor="guided-runtime-api-key">{t('guidedTunnel.apiKeyLabel')}</label>
            <div className="password-input-wrapper guided-key-input">
              <input
                id="guided-runtime-api-key"
                name="apiKey"
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <button type="button" className="toggle-pw-btn" onClick={() => setShowApiKey((shown) => !shown)}>
                {showApiKey ? t('guidedTunnel.hideApiKey') : t('guidedTunnel.showApiKey')}
              </button>
            </div>
            <p className="hint">{t('guidedTunnel.apiKeyHint')}</p>
            <div className="inline-actions">
              <button type="button" onClick={goBack}>{t('guidedTunnel.back')}</button>
              <button type="button" className="btn-save-gold" disabled={busyAction !== null} onClick={() => { void saveApiKey(); }}>
                {t('guidedTunnel.saveKey')}
              </button>
            </div>
          </>
        ) : null}

        {step === 'configure' ? (
          <>
            <StepHeading title={t('guidedTunnel.stepConfigureTitle')} body={t('guidedTunnel.stepConfigureBody')} />
            <div className="guided-tunnel-summary">
              <SummaryRow label={t('guidedTunnel.tunnelIdLabel')} value={props.tunnel.profileExists ? (props.tunnel.persistent?.tunnelIdMasked ?? t('guidedTunnel.configured')) : maskTunnelId(tunnelId)} />
              <SummaryRow label={t('guidedTunnel.apiKeyLabel')} value={props.tunnel.hasApiKey ? t('guidedTunnel.keyStored') : '—'} />
            </div>
            <div className="inline-actions">
              <button type="button" onClick={goBack}>{t('guidedTunnel.back')}</button>
              <button type="button" className="btn-save-gold" disabled={busyAction !== null || !props.tunnel.hasApiKey} onClick={() => { void configureProfile(); }}>
                {busyAction === 'configure' ? t('guidedTunnel.configuring') : t('guidedTunnel.configure')}
              </button>
            </div>
          </>
        ) : null}

        {step === 'start' ? (
          <>
            <StepHeading title={t('guidedTunnel.stepStartTitle')} body={t('guidedTunnel.stepStartBody')} />
            <div className="guided-tunnel-summary">
              <SummaryRow label={t('guidedTunnel.tunnelIdLabel')} value={props.tunnel.persistent?.tunnelIdMasked ?? (props.tunnel.profileExists ? t('guidedTunnel.configured') : '—')} />
              <SummaryRow label={t('guidedTunnel.apiKeyLabel')} value={props.tunnel.hasApiKey ? t('guidedTunnel.keyStored') : '—'} />
              <SummaryRow label={t('guidedTunnel.progress')} value={props.tunnel.profileExists ? t('guidedTunnel.configured') : t('tunnel.needProfile')} />
            </div>
            {props.tunnel.persistent?.lastErrorCode === 'TUNNEL_ID_MISMATCH' ? (
              <div className="alert-box-warning" role="status">⚠️ {t('guidedTunnel.persistentRestartNotice')}</div>
            ) : null}
            <div className="inline-actions">
              <button type="button" onClick={goBack}>{t('guidedTunnel.back')}</button>
              <button type="button" className="btn-save-gold" disabled={!canStart} onClick={() => { void startTunnel(); }}>
                {busyAction === 'start' ? t('guidedTunnel.starting') : t('guidedTunnel.startTunnel')}
              </button>
            </div>
          </>
        ) : null}

        {step === 'connect_chatgpt' ? (
          <>
            <div className="guided-tunnel-complete">✓ {t('guidedTunnel.localComplete')}</div>
            <StepHeading title={t('guidedTunnel.stepChatGptTitle')} body={t('guidedTunnel.stepChatGptBody')} />
            <div className="guided-tunnel-summary">
              <SummaryRow label={t('guidedTunnel.tunnelIdLabel')} value={props.tunnel.persistent?.tunnelIdMasked ?? t('guidedTunnel.configured')} />
              <SummaryRow label={t('guidedTunnel.progress')} value={t('guidedTunnel.running')} />
            </div>
            <div className="inline-actions">
              <button type="button" onClick={() => { void openExternal('chatgpt_plugins'); }}>{t('guidedTunnel.openChatGptPlugins')}</button>
              <button type="button" className="btn-save-gold" onClick={close}>{t('guidedTunnel.done')}</button>
            </div>
          </>
        ) : null}

        {error === null ? null : <div className="alert-box-warning" role="alert">⚠️ {error}</div>}
        {notice === null ? null : <div className="toast-success-banner" role="status">✓ {notice}</div>}
        {fallbackUrl === null ? null : (
          <div className="guided-link-fallback" role="alert">
            <strong>{t('guidedTunnel.linkError')}</strong>
            <code className="settings-path-display">{fallbackUrl}</code>
            <button type="button" onClick={() => { void copyTextToClipboard(fallbackUrl); }}>{t('guidedTunnel.copyLink')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function StepHeading(props: { readonly title: string; readonly body: string }): ReactElement {
  return <div className="guided-step-heading"><h4>{props.title}</h4><p>{props.body}</p></div>;
}

function SummaryRow(props: { readonly label: string; readonly value: string }): ReactElement {
  return <div><span>{props.label}</span><strong>{props.value}</strong></div>;
}

function maskTunnelId(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 14) return normalized;
  return `${normalized.slice(0, 11)}${'*'.repeat(Math.max(4, normalized.length - 15))}${normalized.slice(-4)}`;
}

function safeErrorMessage(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : fallback;
  return raw.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}

function progressLabel(step: GuidedTunnelStep, t: ReturnType<typeof createTranslator>): string {
  switch (step) {
    case 'create_tunnel': return t('guidedTunnel.tunnelIdLabel');
    case 'save_key': return t('guidedTunnel.apiKeyLabel');
    case 'configure': return t('guidedTunnel.configure');
    case 'start': return t('guidedTunnel.startTunnel');
    case 'connect_chatgpt': return 'ChatGPT';
  }
}
