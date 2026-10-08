import type { ReactElement } from 'react';
import type {
  PonytailMode,
  PonytailModeOverride,
  PonytailPolicyContext,
  PonytailPolicySource,
  UiLocale,
} from '@lnwjud/ipc-contracts';
import { createTranslator, type Translator } from '../../i18n/index.js';
import { EmptyState, SettingsCardHeading, StatusMessage , FormSelect } from '../ui/UiPrimitives.js';

interface PonytailPolicyEditorProps {
  readonly locale: UiLocale;
  readonly globalMode: PonytailMode;
  readonly context: PonytailPolicyContext | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onGlobalModeChange: (mode: PonytailMode) => Promise<void>;
  readonly onWorkspaceModeChange: (mode: PonytailModeOverride) => Promise<void>;
  readonly onGoalModeChange: (goalId: string, expectedRevision: number, mode: PonytailModeOverride) => Promise<void>;
}

const MODES: readonly PonytailMode[] = ['off', 'lite', 'full', 'ultra'];

export function PonytailPolicyEditor(props: PonytailPolicyEditorProps): ReactElement {
  const t = createTranslator(props.locale);
  const context = props.context;
  const effectiveMode = context?.effectiveWorkspaceMode ?? props.globalMode;
  const effectiveSource = context?.effectiveWorkspaceSource ?? 'global';

  return (
    <section className="panel settings-card settings-card-polished" aria-label={t('settingsPage.ponytailTitle')} data-settings-focus="ponytail-policy" tabIndex={-1}>
      <SettingsCardHeading
        icon="P"
        title={t('settingsPage.ponytailTitle')}
        subtitle={t('settingsPage.ponytailSubtitle')}
        badge={t('settingsPage.ponytailEffectiveBadge', { mode: modeLabel(t, effectiveMode) })}
      />

      <div className="setting-field max-field-width">
        <label className="field-label" htmlFor="ponytail-global-mode">{t('settingsPage.ponytailGlobalDefault')}</label>
        <FormSelect
          id="ponytail-global-mode"
          className="settings-select"
          disabled={props.busy}
          value={props.globalMode}
          onChange={(event) => {
            void props.onGlobalModeChange(event.target.value as PonytailMode).catch(() => undefined);
          }}
        >
          {MODES.map((mode) => <option key={mode} value={mode}>{modeLabel(t, mode)}</option>)}
        </FormSelect>
        <p className="hint">{t('userConfig.ponytailHint')}</p>
      </div>

      <details className="guided-tunnel-advanced ponytail-scope-overrides">
        <summary>
          {t('settingsPage.ponytailOverridesOptional')} · {modeLabel(t, effectiveMode)} · {policySourceLabel(t, effectiveSource)}
        </summary>
        {context === null ? (
          <EmptyState>{t('settingsPage.ponytailSelectProject')}</EmptyState>
        ) : (
          <>
            <div className="setting-field max-field-width">
              <label className="field-label" htmlFor="ponytail-workspace-mode">{t('settingsPage.ponytailWorkspaceOverride')}</label>
              <FormSelect
                id="ponytail-workspace-mode"
                className="settings-select"
                disabled={props.busy}
                value={context.workspaceMode}
                onChange={(event) => {
                  void props.onWorkspaceModeChange(event.target.value as PonytailModeOverride).catch(() => undefined);
                }}
              >
                <option value="inherit">{t('settingsPage.inheritGlobal')}</option>
                {MODES.map((mode) => <option key={mode} value={mode}>{modeLabel(t, mode)}</option>)}
              </FormSelect>
              <p className="hint">
                {t('settingsPage.ponytailEffective')}: {modeLabel(t, context.effectiveWorkspaceMode)} · {policySourceLabel(t, context.effectiveWorkspaceSource)}
                {context.workspaceMode === 'inherit' ? ` · ${t('settingsPage.ponytailInherited')}` : ''}
              </p>
            </div>

            <div className="settings-mini-heading">
              <strong>{t('settingsPage.currentGoalOverrides')}</strong>
              <span>{context.activeGoals.length}</span>
            </div>
            {context.activeGoals.length === 0 ? (
              <EmptyState>{t('settingsPage.noActiveGoals')}</EmptyState>
            ) : (
              <div className="backup-list settings-backup-list ponytail-goal-list">
                {context.activeGoals.map((goal) => (
                  <div className="backup-item ponytail-goal-item" key={goal.goalId}>
                    <div className="ponytail-goal-copy">
                      <strong>{goal.goalKey}</strong>
                      <p className="hint">
                        {t('settingsPage.ponytailEffective')}: {modeLabel(t, goal.effectiveMode)} · {policySourceLabel(t, goal.effectiveSource)} · rev {goal.revision}
                        {goal.mode === 'inherit' ? ` · ${t('settingsPage.ponytailInherited')}` : ''}
                      </p>
                      {goal.editBlockedReason === null ? null : <p className="hint">{goalBlockedLabel(t, goal.editBlockedReason)}</p>}
                    </div>
                    <FormSelect
                      aria-label={t('settingsPage.goalModeAria', { goal: goal.goalKey })}
                      className="settings-select ponytail-goal-select"
                      disabled={props.busy || !goal.editable}
                      value={goal.mode}
                      onChange={(event) => {
                        void props.onGoalModeChange(goal.goalId, goal.revision, event.target.value as PonytailModeOverride).catch(() => undefined);
                      }}
                    >
                      <option value="inherit">{t('settingsPage.inheritWorkspace')}</option>
                      {MODES.map((mode) => <option key={mode} value={mode}>{modeLabel(t, mode)}</option>)}
                    </FormSelect>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </details>

      {props.error === null ? null : <StatusMessage tone="warning" role="alert" prefix="⚠️ ">{props.error}</StatusMessage>}
    </section>
  );
}

function modeLabel(t: Translator, mode: PonytailMode): string {
  const keys = {
    off: 'settingsPage.ponytailModeOff',
    lite: 'settingsPage.ponytailModeLite',
    full: 'settingsPage.ponytailModeFull',
    ultra: 'settingsPage.ponytailModeUltra',
  } as const;
  return t(keys[mode]);
}

function policySourceLabel(t: Translator, source: PonytailPolicySource): string {
  if (source === 'goal') return t('settingsPage.sourceGoal');
  if (source === 'workspace') return t('settingsPage.sourceWorkspace');
  if (source === 'global') return t('settingsPage.sourceGlobal');
  return t('settingsPage.sourceDefault');
}

function goalBlockedLabel(t: Translator, reason: 'live_lease' | 'live_continuation' | 'live_mutation'): string {
  if (reason === 'live_lease') return t('settingsPage.goalLockLease');
  if (reason === 'live_continuation') return t('settingsPage.goalLockContinuation');
  return t('settingsPage.goalLockMutation');
}
