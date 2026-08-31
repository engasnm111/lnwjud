import type {
  DoctorCheck,
  DoctorReport,
  RequirementResult,
  ToolCatalogItem,
  ToolCatalogSnapshot,
  ToolDeclaredPermission,
  ToolProfileDecision,
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
      checks.push({
        id,
        required: result.required,
        status: result.status,
        title: localizedRequirementTitle(locale, id),
        summary: localizedRequirementSummary(locale, result),
        ...(result.detail === undefined ? {} : { detail: redactDetail(result.detail) }),
        affectedToolNames,
        ...(result.remediationId === undefined ? {} : { remediationId: result.remediationId }),
        checkedAt: result.checkedAt,
        durationMs: result.durationMs,
        message: localizedRequirementSummary(locale, result),
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
      const codexDisabled = definition.name.startsWith('codex_') && this.#options.codexEnabled?.() === false;
      const readiness = computeReadiness(requirementResults, profileDecision, delivery, codexDisabled);
      const requirementRemediationIds = requirementResults.flatMap((result) => result.status === 'pass' || result.remediationId === undefined ? [] : [result.remediationId]);
      const primaryRemediationIds = readiness === 'disabled'
        ? codexDisabled
          ? ['configure_codex']
          : delivery === 'planned'
            ? ['feature_planned']
            : ['feature_not_available']
        : readiness === 'blocked'
          ? ['configure_permissions']
          : readiness === 'needs_setup' || readiness === 'unknown'
            ? requirementRemediationIds
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

function computeReadiness(requirements: readonly RequirementResult[], profileDecision: ToolProfileDecision, delivery: string | undefined, codexDisabled: boolean): ToolReadinessStatus {
  if (delivery === 'feature_disabled' || delivery === 'planned' || codexDisabled) return 'disabled';
  if (profileDecision === 'DENY') return 'blocked';
  if (requirements.some((result) => result.id === 'platform_windows' && result.status === 'fail')) return 'unsupported';
  if (requirements.some((result) => result.status === 'unknown')) return 'unknown';
  if (requirements.some((result) => result.status === 'fail' || result.status === 'warn')) return 'needs_setup';
  return 'ready';
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
