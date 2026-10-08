import type { MessageKey } from '../../i18n/messages.js';

export interface ReleaseNoteItem {
  readonly id: string;
  readonly titleKey: MessageKey;
  readonly descriptionKey: MessageKey;
  readonly badge?: 'new' | 'improved' | 'fixed';
  readonly tags?: readonly string[];
}

export interface ReleaseNoteCategory {
  readonly id: 'office' | 'safety' | 'experience';
  readonly titleKey: MessageKey;
  readonly items: readonly ReleaseNoteItem[];
}

export interface ReleaseNote {
  readonly version: string;
  readonly categories: readonly ReleaseNoteCategory[];
}

const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: '5.8.0',
    categories: [
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          { id: 'git-expanded', titleKey: 'whatsNew.580.git.title', descriptionKey: 'whatsNew.580.git.description', badge: 'improved', tags: ['Git', 'untracked files', 'search', 'binary'] },
          { id: 'ui-controls', titleKey: 'whatsNew.580.ui.title', descriptionKey: 'whatsNew.580.ui.description', badge: 'fixed', tags: ['Prompt', 'Doctor', 'Tools', 'dropdown', 'validation', 'Git tree'] },
          { id: 'workflow-templates', titleKey: 'whatsNew.580.workflows.title', descriptionKey: 'whatsNew.580.workflows.description', badge: 'new', tags: ['workflows', 'Thai', 'English', 'AI handoff'] },
          { id: 'dialog-close', titleKey: 'whatsNew.580.dialog.title', descriptionKey: 'whatsNew.580.dialog.description', badge: 'fixed', tags: ['What’s New', 'Tool Detail', 'Tunnel guide', 'modal', 'close'] },
          { id: 'worklog-filters', titleKey: 'whatsNew.580.worklog.title', descriptionKey: 'whatsNew.580.worklog.description', badge: 'improved', tags: ['Work Log', 'Live Logs', 'workspace', 'filter'] },
        ],
      },
      {
        id: 'office',
        titleKey: 'whatsNew.category.office',
        items: [
          { id: 'file-audit', titleKey: 'whatsNew.580.office.title', descriptionKey: 'whatsNew.580.office.description', badge: 'new', tags: ['CSV', 'XLSX', 'audit', 'report preview'] },
        ],
      },
      {
        id: 'safety',
        titleKey: 'whatsNew.category.safety',
        items: [
          { id: 'observability', titleKey: 'whatsNew.580.observability.title', descriptionKey: 'whatsNew.580.observability.description', badge: 'improved', tags: ['MCP', 'Goal', 'resource', 'audit'] },
          { id: 'history', titleKey: 'whatsNew.580.history.title', descriptionKey: 'whatsNew.580.history.description', badge: 'new', tags: ['MCP', 'history', 'latency', 'Goal filters'] },
          { id: 'results', titleKey: 'whatsNew.580.results.title', descriptionKey: 'whatsNew.580.results.description', badge: 'new', tags: ['Goal', 'checkpoints', 'artifacts', 'permissions'] },
          { id: 'resources', titleKey: 'whatsNew.580.resources.title', descriptionKey: 'whatsNew.580.resources.description', badge: 'improved', tags: ['Windows', 'PID', 'CPU', 'memory', 'Context Economy'] },
          { id: 'tunnel-reconnect', titleKey: 'whatsNew.580.tunnel.title', descriptionKey: 'whatsNew.580.tunnel.description', badge: 'fixed', tags: ['Secure MCP Tunnel', 'readiness', 'reconnect', 'backoff'] },
          { id: 'runtime-dependencies', titleKey: 'whatsNew.580.dependencies.title', descriptionKey: 'whatsNew.580.dependencies.description', badge: 'improved', tags: ['tunnel-client 0.0.16', 'dependabot', 'CI', 'PR'] },
          { id: 'release-evidence', titleKey: 'whatsNew.580.release.title', descriptionKey: 'whatsNew.580.release.description', badge: 'improved', tags: ['release', 'SHA256', 'provenance', 'tests'] },
        ],
      },
    ],
  },

  {
    version: '5.7.4',
    categories: [
      {
        id: 'safety',
        titleKey: 'whatsNew.category.safety',
        items: [
          {
            id: 'scrollable-high-risk-approval',
            titleKey: 'whatsNew.574.mutationApproval.title',
            descriptionKey: 'whatsNew.574.mutationApproval.description',
            badge: 'fixed',
            tags: ['mutation approval', 'scrollable', 'Windows', 'macOS', 'Linux'],
          },
        ],
      },
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'bounded-native-alert-text',
            titleKey: 'whatsNew.574.nativeDialogs.title',
            descriptionKey: 'whatsNew.574.nativeDialogs.description',
            badge: 'improved',
            tags: ['native dialogs', 'long errors', 'screen fit'],
          },
        ],
      },
    ],
  },
  {
    version: '5.7.3',
    categories: [
      {
        id: 'safety',
        titleKey: 'whatsNew.category.safety',
        items: [
          {
            id: 'engineering-evidence-and-windows-signing',
            titleKey: 'whatsNew.573.engineeringEvidence.title',
            descriptionKey: 'whatsNew.573.engineeringEvidence.description',
            badge: 'improved',
            tags: ['Engineering Harness', 'exact SHA', 'cross-platform', 'Authenticode'],
          },
          {
            id: 'durable-goal-continuity',
            titleKey: 'whatsNew.573.goalContinuity.title',
            descriptionKey: 'whatsNew.573.goalContinuity.description',
            badge: 'fixed',
            tags: ['Durable Goal', 'Ponytail', 'skill activation', 'finish_goal', 'CAS'],
          },
          {
            id: 'external-mcp-session-lifecycle',
            titleKey: 'whatsNew.573.mcpLifecycle.title',
            descriptionKey: 'whatsNew.573.mcpLifecycle.description',
            badge: 'fixed',
            tags: ['Serena', 'External MCP', 'process reuse', 'cleanup'],
          },
        ],
      },
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'linux-appimage-secure-storage-startup',
            titleKey: 'whatsNew.573.linuxStartup.title',
            descriptionKey: 'whatsNew.573.linuxStartup.description',
            badge: 'fixed',
            tags: ['Linux', 'AppImage', 'secure storage', 'FUSE'],
          },
          {
            id: 'truthful-log-severity-and-copyable-scope',
            titleKey: 'whatsNew.573.logSeverity.title',
            descriptionKey: 'whatsNew.573.logSeverity.description',
            badge: 'improved',
            tags: ['Work Log', 'Live Logs', 'INFO', 'WARN', 'ERROR', 'Workspace ID'],
          },
          {
            id: 'fresh-tunnel-and-recovery-defaults',
            titleKey: 'whatsNew.573.tunnelRecovery.title',
            descriptionKey: 'whatsNew.573.tunnelRecovery.description',
            badge: 'improved',
            tags: ['Secure MCP Tunnel', 'Portable', 'bundled tunnel-client', 'auto reconnect', 'recovery', '3 days'],
          },
          {
            id: 'browser-native-foreground-coordination',
            titleKey: 'whatsNew.573.browserCoordination.title',
            descriptionKey: 'whatsNew.573.browserCoordination.description',
            badge: 'fixed',
            tags: ['Managed Browser', 'CDP', 'native input', 'file upload', 'foreground safety'],
          },
        ],
      },
    ],
  },
  {
    version: '5.7.2',
    categories: [
      {
        id: 'safety',
        titleKey: 'whatsNew.category.safety',
        items: [
          {
            id: 'engineering-harness-developer-autonomy',
            titleKey: 'whatsNew.572.developerAutonomy.title',
            descriptionKey: 'whatsNew.572.developerAutonomy.description',
            badge: 'improved',
            tags: ['Engineering Harness', 'Full Bypass', 'Developer Autonomy', 'read-only commands'],
          },
          {
            id: 'engineering-tools-catalog-exposure',
            titleKey: 'whatsNew.572.engineeringCatalog.title',
            descriptionKey: 'whatsNew.572.engineeringCatalog.description',
            badge: 'fixed',
            tags: ['Engineering Harness', 'tool_search', 'tool_describe', 'goalLease'],
          },
        ],
      },
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'engineering-harness-settings-persistence',
            titleKey: 'whatsNew.572.engineeringSettingsPersistence.title',
            descriptionKey: 'whatsNew.572.engineeringSettingsPersistence.description',
            badge: 'fixed',
            tags: ['Engineering Harness', 'Settings', 'restart', 'preload'],
          },
          {
            id: 'prosemirror-contenteditable-typing',
            titleKey: 'whatsNew.572.proseMirrorTyping.title',
            descriptionKey: 'whatsNew.572.proseMirrorTyping.description',
            badge: 'fixed',
            tags: ['dom_cdp', 'ProseMirror', 'contenteditable', 'Input.insertText'],
          },
          {
            id: 'git-image-preview',
            titleKey: 'whatsNew.572.gitImagePreview.title',
            descriptionKey: 'whatsNew.572.gitImagePreview.description',
            badge: 'new',
            tags: ['Git', 'image preview', 'binary diff', 'HEAD', 'Index', 'Working Tree'],
          },
          {
            id: 'durable-goal-progress-freshness',
            titleKey: 'whatsNew.572.goalFreshness.title',
            descriptionKey: 'whatsNew.572.goalFreshness.description',
            badge: 'improved',
            tags: ['Durable Goal', 'checkpoint', 'Watcher', 'progress', 'CI'],
          },
          {
            id: 'tunnel-transient-inventory-retry',
            titleKey: 'whatsNew.572.tunnelInventoryRetry.title',
            descriptionKey: 'whatsNew.572.tunnelInventoryRetry.description',
            badge: 'fixed',
            tags: ['Secure MCP Tunnel', 'Windows', 'PowerShell', 'retry', 'process inventory'],
          },
        ],
      },
    ],
  },
  {
    version: '5.7.1',
    categories: [
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'engineering-checkpoint-gate-results',
            titleKey: 'whatsNew.571.checkpointResults.title',
            descriptionKey: 'whatsNew.571.checkpointResults.description',
            badge: 'fixed',
            tags: ['Engineering Harness', 'checkpoint', 'diff', 'docs_impact'],
          },
        ],
      },
    ],
  },
  {
    version: '5.7.0',
    categories: [
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'engineering-harness-workflow',
            titleKey: 'whatsNew.570.engineeringHarness.title',
            descriptionKey: 'whatsNew.570.engineeringHarness.description',
            badge: 'new',
            tags: ['Engineering Harness', 'Durable Goals', 'workflow'],
          },
          {
            id: 'engineering-harness-settings',
            titleKey: 'whatsNew.570.engineeringSettings.title',
            descriptionKey: 'whatsNew.570.engineeringSettings.description',
            badge: 'new',
            tags: ['Settings', 'Thai', 'English'],
          },
        ],
      },
      {
        id: 'safety',
        titleKey: 'whatsNew.category.safety',
        items: [
          {
            id: 'engineering-harness-evidence',
            titleKey: 'whatsNew.570.engineeringEvidence.title',
            descriptionKey: 'whatsNew.570.engineeringEvidence.description',
            badge: 'improved',
            tags: ['Evidence', 'Review', 'Full Bypass'],
          },
        ],
      },
    ],
  },
  {
    version: '5.6.5',
    categories: [
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'agent-swarm-live-exposure',
            titleKey: 'whatsNew.565.agentSwarm.title',
            descriptionKey: 'whatsNew.565.agentSwarm.description',
            badge: 'fixed',
            tags: ['Agent Swarm', 'Codex', 'MCP'],
          },
          {
            id: 'agent-swarm-setup',
            titleKey: 'whatsNew.565.agentSwarmSetup.title',
            descriptionKey: 'whatsNew.565.agentSwarmSetup.description',
            badge: 'improved',
            tags: ['Settings', 'ChatGPT'],
          },
          {
            id: 'desktop-agent-stop-status',
            titleKey: 'whatsNew.565.desktopAgentStop.title',
            descriptionKey: 'whatsNew.565.desktopAgentStop.description',
            badge: 'fixed',
            tags: ['Desktop Agent', 'Status'],
          },
        ],
      },
      {
        id: 'safety',
        titleKey: 'whatsNew.category.safety',
        items: [
          {
            id: 'checkpoint-key-startup',
            titleKey: 'whatsNew.565.checkpointKey.title',
            descriptionKey: 'whatsNew.565.checkpointKey.description',
            badge: 'fixed',
            tags: ['Recovery', 'Startup'],
          },
        ],
      },
    ],
  },
  {
    version: '5.6.4',
    categories: [
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'tunnel-rebind-after-restart',
            titleKey: 'whatsNew.564.tunnelRebind.title',
            descriptionKey: 'whatsNew.564.tunnelRebind.description',
            badge: 'fixed',
            tags: ['Secure Tunnel', 'Persistent Runtime', 'restart'],
          },
          {
            id: 'chatgpt-tool-schema',
            titleKey: 'whatsNew.564.toolSchema.title',
            descriptionKey: 'whatsNew.564.toolSchema.description',
            badge: 'fixed',
            tags: ['ChatGPT', 'MCP', 'Remote MCP'],
          },
          {
            id: 'tunnel-log-timestamps',
            titleKey: 'whatsNew.564.tunnelLogs.title',
            descriptionKey: 'whatsNew.564.tunnelLogs.description',
            badge: 'fixed',
            tags: ['Tunnel', 'Live Logs'],
          },
          {
            id: 'tunnel-start-controls',
            titleKey: 'whatsNew.564.tunnelControls.title',
            descriptionKey: 'whatsNew.564.tunnelControls.description',
            badge: 'fixed',
            tags: ['Tunnel', 'Controls'],
          },
          {
            id: 'git-changed-files-height',
            titleKey: 'whatsNew.564.gitFilesHeight.title',
            descriptionKey: 'whatsNew.564.gitFilesHeight.description',
            badge: 'fixed',
            tags: ['Git', 'Desktop'],
          },
        ],
      },
    ],
  },
  {
    version: '5.6.3',
    categories: [
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'secure-tunnel-discovery',
            titleKey: 'whatsNew.563.tunnelDiscovery.title',
            descriptionKey: 'whatsNew.563.tunnelDiscovery.description',
            badge: 'fixed',
            tags: ['Secure Tunnel', 'OAuth discovery', 'tunnel-client'],
          },
          {
            id: 'codex-runtime-discovery',
            titleKey: 'whatsNew.563.codexRuntime.title',
            descriptionKey: 'whatsNew.563.codexRuntime.description',
            badge: 'fixed',
            tags: ['Codex', 'Windows', 'runtime'],
          },
          {
            id: 'tunnel-client-0015',
            titleKey: 'whatsNew.563.tunnelClient.title',
            descriptionKey: 'whatsNew.563.tunnelClient.description',
            badge: 'improved',
            tags: ['Secure Tunnel', 'tunnel-client', '0.0.15'],
          },
        ],
      },
      {
        id: 'safety',
        titleKey: 'whatsNew.category.safety',
        items: [
          {
            id: 'recovery-retention',
            titleKey: 'whatsNew.563.recoveryRetention.title',
            descriptionKey: 'whatsNew.563.recoveryRetention.description',
            badge: 'fixed',
            tags: ['Recovery', 'Backup', 'retention'],
          },
          {
            id: 'recovery-delete-controls',
            titleKey: 'whatsNew.563.recoveryDelete.title',
            descriptionKey: 'whatsNew.563.recoveryDelete.description',
            badge: 'new',
            tags: ['Recovery Trash', 'checkpoints', 'backup'],
          },
        ],
      },
    ],
  },
  {
    version: '5.6.2',
    categories: [
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'context-economy-http',
            titleKey: 'whatsNew.562.contextEconomy.title',
            descriptionKey: 'whatsNew.562.contextEconomy.description',
            badge: 'fixed',
            tags: ['MCP', 'Context Economy', 'HTTP'],
          },
          {
            id: 'binary-context-filter',
            titleKey: 'whatsNew.562.binaryContext.title',
            descriptionKey: 'whatsNew.562.binaryContext.description',
            badge: 'fixed',
            tags: ['Context', 'binary', '.DS_Store'],
          },
          {
            id: 'tunnel-transition-lock',
            titleKey: 'whatsNew.562.tunnelBusy.title',
            descriptionKey: 'whatsNew.562.tunnelBusy.description',
            badge: 'fixed',
            tags: ['Secure Tunnel', 'Settings', 'UI'],
          },
          {
            id: 'scheduled-claim-binding',
            titleKey: 'whatsNew.562.claimBinding.title',
            descriptionKey: 'whatsNew.562.claimBinding.description',
            badge: 'fixed',
            tags: ['Scheduled Continuation', 'MCP'],
          },
        ],
      },
    ],
  },
  {
    version: '5.6.1',
    categories: [
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'watcher-observability',
            titleKey: 'whatsNew.561.watcherObservability.title',
            descriptionKey: 'whatsNew.561.watcherObservability.description',
            badge: 'improved',
            tags: ['Watcher', 'agents', 'activity', 'Git'],
          },
          {
            id: 'watcher-multi-project',
            titleKey: 'whatsNew.561.watcherMultiProject.title',
            descriptionKey: 'whatsNew.561.watcherMultiProject.description',
            badge: 'new',
            tags: ['Watcher', 'projects', 'goals', 'parallel'],
          },
          {
            id: 'git-scroll',
            titleKey: 'whatsNew.561.gitScroll.title',
            descriptionKey: 'whatsNew.561.gitScroll.description',
            badge: 'fixed',
            tags: ['Git', 'scroll', 'diff', 'UI'],
          },
          {
            id: 'watcher-pairing-ui',
            titleKey: 'whatsNew.561.pairingUi.title',
            descriptionKey: 'whatsNew.561.pairingUi.description',
            badge: 'improved',
            tags: ['Watcher', 'pairing', 'token', 'UX'],
          },
          {
            id: 'settings-scroll',
            titleKey: 'whatsNew.561.settingsScroll.title',
            descriptionKey: 'whatsNew.561.settingsScroll.description',
            badge: 'fixed',
            tags: ['Settings', 'scroll', 'Remote MCP', 'UI'],
          },
        ],
      },
    ],
  },
  {
    version: '5.6.0',
    categories: [
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'watcher-runtime',
            titleKey: 'whatsNew.560.watcher.title',
            descriptionKey: 'whatsNew.560.watcher.description',
            badge: 'new',
            tags: ['Watcher', 'realtime', 'WebSocket', 'mobile'],
          },
          {
            id: 'watcher-autostart',
            titleKey: 'whatsNew.560.autostart.title',
            descriptionKey: 'whatsNew.560.autostart.description',
            badge: 'new',
            tags: ['Watcher', 'startup', 'desktop'],
          },
          {
            id: 'watcher-live-sync',
            titleKey: 'whatsNew.560.liveSync.title',
            descriptionKey: 'whatsNew.560.liveSync.description',
            badge: 'fixed',
            tags: ['Watcher', 'WebSocket', 'auth', 'snapshot'],
          },
          {
            id: 'git-diff-scroll',
            titleKey: 'whatsNew.560.gitDiff.title',
            descriptionKey: 'whatsNew.560.gitDiff.description',
            badge: 'improved',
            tags: ['Git', 'diff', 'scroll', 'desktop'],
          },
        ],
      },
      {
        id: 'safety',
        titleKey: 'whatsNew.category.safety',
        items: [
          {
            id: 'watcher-readonly-auth',
            titleKey: 'whatsNew.560.security.title',
            descriptionKey: 'whatsNew.560.security.description',
            badge: 'new',
            tags: ['Watcher', 'read-only', 'token', 'pairing'],
          },
          {
            id: 'scheduled-continuation-recovery',
            titleKey: 'whatsNew.560.schedulerRecovery.title',
            descriptionKey: 'whatsNew.560.schedulerRecovery.description',
            badge: 'fixed',
            tags: ['Scheduled Tasks', 'durable goals', 'liveness', 'recovery'],
          },
        ],
      },
    ],
  },
  {
    version: '5.5.3',
    categories: [
      {
        id: 'safety',
        titleKey: 'whatsNew.category.safety',
        items: [
          {
            id: 'scheduled-connector-binding',
            titleKey: 'whatsNew.553.connector.title',
            descriptionKey: 'whatsNew.553.connector.description',
            badge: 'fixed',
            tags: ['Scheduled Tasks', 'MCP', 'connector', 'durable goals'],
          },
        ],
      },
    ],
  },
  {
    version: '5.5.2',
    categories: [
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'mcp-continuation-lifecycle',
            titleKey: 'whatsNew.552.continuation.title',
            descriptionKey: 'whatsNew.552.continuation.description',
            badge: 'fixed',
            tags: ['MCP', 'Secure Tunnel', 'continuation', 'large files'],
          },
        ],
      },
    ],
  },
  {
    version: '5.5.1',
    categories: [
      {
        id: 'safety',
        titleKey: 'whatsNew.category.safety',
        items: [
          {
            id: 'mutation-ownership',
            titleKey: 'whatsNew.551.mutationOwnership.title',
            descriptionKey: 'whatsNew.551.mutationOwnership.description',
            badge: 'fixed',
            tags: ['durable-goals', 'mutation-safety', 'scheduler'],
          },
        ],
      },
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'windows-startup',
            titleKey: 'whatsNew.551.windowsStartup.title',
            descriptionKey: 'whatsNew.551.windowsStartup.description',
            badge: 'fixed',
            tags: ['Windows 10', 'startup', 'ZIP'],
          },
          {
            id: 'scheduled-bundle-freshness',
            titleKey: 'whatsNew.551.scheduledBundle.title',
            descriptionKey: 'whatsNew.551.scheduledBundle.description',
            badge: 'fixed',
            tags: ['packaging', 'scheduled-tasks', 'durable-goals'],
          },
          {
            id: 'persistent-tunnel-reconnect',
            titleKey: 'whatsNew.551.tunnelReconnect.title',
            descriptionKey: 'whatsNew.551.tunnelReconnect.description',
            badge: 'fixed',
            tags: ['Tunnel', 'reconnect', 'Persistent Runtime'],
          },
          {
            id: 'modal-centering',
            titleKey: 'whatsNew.551.modalCentering.title',
            descriptionKey: 'whatsNew.551.modalCentering.description',
            badge: 'improved',
            tags: ['release-notes', 'accessibility', 'UI'],
          },
        ],
      },
    ],
  },
  {
    version: '5.5.0',
    categories: [
      {
        id: 'office',
        titleKey: 'whatsNew.category.office',
        items: [
          {
            id: 'office-semantic-suite',
            titleKey: 'whatsNew.550.officeSuite.title',
            descriptionKey: 'whatsNew.550.officeSuite.description',
            badge: 'new',
            tags: ['Office', 'Word', 'Excel', 'PowerPoint', 'Outlook'],
          },
          {
            id: 'office-readiness',
            titleKey: 'whatsNew.550.readiness.title',
            descriptionKey: 'whatsNew.550.readiness.description',
            badge: 'improved',
            tags: ['providers', 'readiness'],
          },
        ],
      },
      {
        id: 'safety',
        titleKey: 'whatsNew.category.safety',
        items: [
          {
            id: 'office-safety',
            titleKey: 'whatsNew.550.safety.title',
            descriptionKey: 'whatsNew.550.safety.description',
            badge: 'improved',
            tags: ['dry-run', 'recovery', 'permissions'],
          },
        ],
      },
      {
        id: 'experience',
        titleKey: 'whatsNew.category.experience',
        items: [
          {
            id: 'remote-mcp-transports',
            titleKey: 'whatsNew.550.remoteMcp.title',
            descriptionKey: 'whatsNew.550.remoteMcp.description',
            badge: 'new',
            tags: ['MCP', 'Cloudflare', 'ngrok', 'Local MCP'],
          },
          {
            id: 'tunnel-auto-start',
            titleKey: 'whatsNew.550.tunnelAutoStart.title',
            descriptionKey: 'whatsNew.550.tunnelAutoStart.description',
            badge: 'improved',
            tags: ['Tunnel', 'startup', 'reconnect'],
          },
          {
            id: 'scheduled-continuation',
            titleKey: 'whatsNew.550.scheduler.title',
            descriptionKey: 'whatsNew.550.scheduler.description',
            badge: 'fixed',
            tags: ['scheduled-tasks', 'durable-goals'],
          },
          {
            id: 'reconnect-result-recovery',
            titleKey: 'whatsNew.550.reconnectRecovery.title',
            descriptionKey: 'whatsNew.550.reconnectRecovery.description',
            badge: 'fixed',
            tags: ['reconnect', 'durable-goals', 'recovery'],
          },
          {
            id: 'search-edit-recovery',
            titleKey: 'whatsNew.550.searchEdit.title',
            descriptionKey: 'whatsNew.550.searchEdit.description',
            badge: 'fixed',
            tags: ['search', 'edit-file', 'recovery'],
          },
          {
            id: 'whats-new',
            titleKey: 'whatsNew.550.modal.title',
            descriptionKey: 'whatsNew.550.modal.description',
            badge: 'new',
            tags: ['release-notes', 'i18n'],
          },
        ],
      },
    ],
  },
];

export function releaseNotesForVersion(version: string): ReleaseNote | undefined {
  return RELEASE_NOTES.find((entry) => entry.version === version.trim());
}
