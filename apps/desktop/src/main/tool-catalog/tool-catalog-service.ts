import type {
  DoctorCheck,
  DoctorReport,
  RequirementResult,
  ToolCatalogItem,
  ToolCatalogSnapshot,
  ToolDeclaredPermission,
  ToolDeliveryState,
  ToolProfileDecision,
  ToolReadinessReason,
  ToolReadinessStatus,
  UiLocale,
} from '@lnwjud/ipc-contracts';
import { ToolRegistry, upgradeCatalogEntry } from '@lnwjud/mcp-server';
import { catalogDefinitions } from './catalog-definitions.js';
import { resolveCatalogCopy } from './catalog-copy.js';
import { RequirementRegistry, type RequirementSnapshot } from './requirement-registry.js';
import { RemediationRegistry } from './remediation-registry.js';

export interface ToolCatalogServiceOptions {
  readonly profileDecision?: (permission: ToolDeclaredPermission, toolName: string) => ToolProfileDecision;
  readonly codexEnabled?: () => boolean;
  readonly externalItems?: (locale: UiLocale) => Promise<readonly ToolCatalogItem[]>;
  readonly now?: () => Date;
}

const actor = { clientId: 'desktop-tool-catalog-service', clientName: 'Desktop Tool Catalog Service' };
const liveRegistry = new ToolRegistry({}, actor, { codexToolsEnabled: true });
const liveDefinitions = liveRegistry.listAll();
const definitionByName = new Map(liveDefinitions.map((definition) => [definition.name, definition] as const));
const requirementRemediationIds: Readonly<Record<string, string>> = {
  windows_ui_automation: 'repair_windows_ui_automation',
  windows_input: 'repair_windows_input',
  windows_window: 'repair_windows_window',
  windows_ocr: 'repair_windows_ocr',
};

export class ToolCatalogService {
  readonly #requirements: RequirementRegistry;
  readonly #remediations: RemediationRegistry;
  readonly #options: ToolCatalogServiceOptions;

  public constructor(requirements: RequirementRegistry, remediations = new RemediationRegistry(), options: ToolCatalogServiceOptions = {}) {
    this.#requirements = requirements;
    this.#remediations = remediations;
    this.#options = options;
  }

  public async getSnapshot(locale: UiLocale): Promise<ToolCatalogSnapshot> {
    return this.#snapshot(locale, false);
  }

  public async recheck(requirementIds: readonly string[], locale: UiLocale): Promise<{ readonly catalog: ToolCatalogSnapshot; readonly doctor: DoctorReport }> {
    await this.#requirements.probe(requirementIds, true);
    const catalog = await this.#snapshot(locale, false);
    return { catalog, doctor: await this.runDoctor(undefined, locale) };
  }

  public async runDoctor(checkIds: readonly string[] | undefined, locale: UiLocale): Promise<DoctorReport> {
    const ids = checkIds ?? this.#requirements.ids();
    const results = await this.#requirements.probe(ids, checkIds !== undefined);
    const checks: DoctorCheck[] = [];
    for (const id of ids) {
      const result = results.get(id);
      if (result === undefined) continue;
      const affectedToolNames = Object.values(catalogDefinitions)
        .filter((definition) => definition.requirementIds.includes(id))
        .map((definition) => definition.name)
        .sort();
      const optionalExternalMcpAbsent = id === 'external_mcp_connection' && result.status === 'warn';
      const doctorResult = optionalExternalMcpAbsent ? { ...result, status: 'pass' as const } : result;
      checks.push({
        id,
        required: doctorResult.required,
        status: doctorResult.status,
        title: localizedRequirementTitle(locale, id),
        summary: localizedRequirementSummary(locale, doctorResult),
        ...(doctorResult.detail === undefined ? {} : { detail: redactDetail(doctorResult.detail) }),
        affectedToolNames,
        ...(optionalExternalMcpAbsent || doctorResult.remediationId === undefined ? {} : { remediationId: doctorResult.remediationId }),
        checkedAt: doctorResult.checkedAt,
        durationMs: doctorResult.durationMs,
        message: localizedRequirementSummary(locale, doctorResult),
      });
    }
    return { checks, exitCode: checks.some((check) => check.required && (check.status === 'fail' || check.status === 'unknown')) ? 1 : 0 };
  }

  async #snapshot(locale: UiLocale, force: boolean): Promise<ToolCatalogSnapshot> {
    const requirementIds = [...new Set(Object.values(catalogDefinitions).flatMap((definition) => definition.requirementIds))];
    const requirements = await this.#requirements.probe(requirementIds, force);
    const firstParty = Object.values(catalogDefinitions).map((definition): ToolCatalogItem => {
      const runtime = definitionByName.get(definition.name);
      const upgrade = upgradeCatalogEntry(definition.name);
      const delivery = upgrade?.deliveryState;
      const declaredPermission = normalizePermission(runtime?.permission);
      const profileDecision = this.#options.profileDecision?.(declaredPermission, definition.name) ?? 'UNKNOWN';
      const requirementResults = definition.requirementIds.flatMap((id): RequirementResult[] => {
        const result = requirements.get(id);
        if (result === undefined) return [];
        if (id === 'feature_delivery' && (delivery === 'feature_disabled' || delivery === 'planned')) {
          return [{ ...stripDuration(result), status: 'fail', detail: localizedDeliveryDetail(locale, delivery, upgrade?.requirements ?? []) }];
        }
        return [stripDuration(result)];
      });
      const codexDisabled = (definition.name.startsWith('codex_') || definition.name === 'agent_swarm_run') && this.#options.codexEnabled?.() === false;
      const readinessState = computeReadiness(requirementResults, profileDecision, delivery, codexDisabled);
      const { readiness, readinessReason, deliveryState, available } = readinessState;
      const failedRequirementRemediationIds = requirementResults.flatMap((result) => {
        if (result.status === 'pass') return [];
        const remediationId = result.remediationId ?? requirementRemediationIds[result.id];
        return remediationId === undefined ? [] : [remediationId];
      });
      const primaryRemediationIds = readinessReason === 'feature_disabled'
        ? codexDisabled
          ? ['configure_codex']
          : ['feature_not_available']
        : readinessReason === 'planned'
          ? ['feature_planned']
        : readinessReason === 'permission_denied'
          ? ['configure_permissions']
          : readinessReason === 'probe_failed'
            ? ['recheck_runtime']
          : readinessReason === 'setup_required' || readinessReason === 'runtime_not_ready'
            ? failedRequirementRemediationIds
            : [];
      const remediationIds = [...new Set(primaryRemediationIds)].filter((id) => this.#remediations.has(id));
      const stale = definition.requirementIds.some((id) => this.#requirements.stale(id));
      return {
        name: definition.name,
        origin: 'lnwjud',
        category: definition.category,
        title: resolveCatalogCopy(locale, definition.titleKey),
        shortDescription: resolveCatalogCopy(locale, definition.shortDescriptionKey),
        longDescription: resolveCatalogCopy(locale, definition.longDescriptionKey),
        declaredPermission,
        profileDecision,
        riskMode: definition.riskMode,
        readiness,
        ...(readinessReason === undefined ? {} : { readinessReason }),
        deliveryState,
        ...(available === undefined ? {} : { available }),
        stale,
        checkedAt: latestCheckedAt(requirementResults),
        supportsCancel: definition.supportsCancel,
        supportsDryRun: definition.supportsDryRun,
        requirements: requirementResults,
        remediationIds,
        inputSchema: runtime === undefined ? null : liveRegistry.describeInputJsonSchema(definition.name) ?? null,
        searchText: [
          definition.name,
          resolveCatalogCopy('en', definition.titleKey), resolveCatalogCopy('th', definition.titleKey),
          resolveCatalogCopy('en', definition.shortDescriptionKey), resolveCatalogCopy('th', definition.shortDescriptionKey),
          resolveCatalogCopy('en', definition.longDescriptionKey), resolveCatalogCopy('th', definition.longDescriptionKey),
        ],
      };
    });
    const external = await this.#options.externalItems?.(locale) ?? [];
    const remediationIds = [...new Set([...firstParty, ...external].flatMap((item) => item.remediationIds))];
    return {
      generatedAt: (this.#options.now?.() ?? new Date()).toISOString(),
      locale,
      items: [...firstParty, ...external],
      remediations: this.#remediations.resolve(locale, remediationIds),
    };
  }
}

interface ComputedReadiness {
  readonly readiness: ToolReadinessStatus;
  readonly readinessReason?: ToolReadinessReason;
  readonly deliveryState: ToolDeliveryState;
  readonly available?: boolean;
}

function computeReadiness(requirements: readonly RequirementResult[], profileDecision: ToolProfileDecision, delivery: string | undefined, codexDisabled: boolean): ComputedReadiness {
  if (delivery === 'planned') return { readiness: 'disabled', readinessReason: 'planned', deliveryState: 'planned', available: false };
  if (delivery === 'feature_disabled' || codexDisabled) return { readiness: 'disabled', readinessReason: 'feature_disabled', deliveryState: 'feature_disabled', available: false };
  if (profileDecision === 'DENY') {
    const available = inferRuntimeAvailability(requirements);
    return {
      readiness: 'blocked',
      readinessReason: 'permission_denied',
      deliveryState: 'blocked_by_safety_policy',
      ...(available === undefined ? {} : { available }),
    };
  }
  if (requirements.some((result) => result.id === 'platform_windows' && result.status === 'fail')) {
    return { readiness: 'unsupported', readinessReason: 'unsupported_platform', deliveryState: 'unsupported', available: false };
  }
  if (requirements.some((result) => result.status === 'unknown')) {
    return { readiness: 'unknown', readinessReason: 'probe_failed', deliveryState: 'dependency_gated' };
  }
  if (requirements.some((result) => result.id === 'browser_cdp' && (result.status === 'fail' || result.status === 'warn'))) {
    return { readiness: 'needs_setup', readinessReason: 'runtime_not_ready', deliveryState: 'operational', available: true };
  }
  if (requirements.some((result) => result.status === 'fail' || result.status === 'warn')) {
    return { readiness: 'needs_setup', readinessReason: 'setup_required', deliveryState: 'dependency_gated', available: false };
  }
  return { readiness: 'ready', deliveryState: delivery === 'dependency_gated' ? 'dependency_gated' : 'operational', available: true };
}

function inferRuntimeAvailability(requirements: readonly RequirementResult[]): boolean | undefined {
  if (requirements.some((result) => result.status === 'unknown')) return undefined;
  if (requirements.some((result) => result.id === 'platform_windows' && result.status === 'fail')) return false;
  if (requirements.some((result) => result.id !== 'browser_cdp' && (result.status === 'fail' || result.status === 'warn'))) return false;
  return true;
}

function normalizePermission(value: unknown): ToolDeclaredPermission {
  return value === 'READ' || value === 'WRITE' || value === 'EXECUTE' || value === 'DANGEROUS' ? value : 'UNKNOWN';
}
function stripDuration(result: RequirementSnapshot): RequirementResult {
  const { durationMs, ...rest } = result;
  void durationMs;
  return rest;
}
function latestCheckedAt(results: readonly RequirementResult[]): string | null {
  if (results.length === 0) return null;
  return results.map((result) => result.checkedAt).sort().at(-1) ?? null;
}
function localizedRequirementTitle(locale: UiLocale, id: string): string { return locale === 'th' ? `ตรวจ ${id}` : `Check ${id}`; }
function localizedDeliveryDetail(locale: UiLocale, delivery: 'feature_disabled' | 'planned', requirements: readonly string[]): string {
  const missing = requirements.length === 0 ? (locale === 'th' ? 'runtime/provider ของฟีเจอร์นี้' : 'this feature runtime/provider') : requirements.join(', ');
  if (delivery === 'planned') return locale === 'th'
    ? `ฟีเจอร์นี้อยู่ในแผน แต่เวอร์ชันที่ติดตั้งยังไม่มีส่วนทำงานจริง: ${missing}`
    : `This feature is planned, but the installed version does not yet contain its runtime: ${missing}`;
  return locale === 'th'
    ? `เวอร์ชันที่ติดตั้งยังไม่มี backend/provider ที่ต้องใช้: ${missing}`
    : `The installed version does not include the required backend/provider: ${missing}`;
}
function localizedRequirementSummary(locale: UiLocale, result: RequirementSnapshot): string {
  const status = result.status.toUpperCase();
  return locale === 'th' ? `${status}: ${result.summaryKey}` : `${status}: ${result.summaryKey}`;
}
function redactDetail(detail: string): string {
  return detail.replace(/(?:sk|token|key)-[A-Za-z0-9_-]{12,}/gi, '[redacted]').slice(0, 2_048);
}
