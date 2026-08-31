import { createHash, randomUUID } from 'node:crypto';
import { appError, err, isApplicationAuthorized, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { CapabilityService } from '@lnwjud/capabilities';

interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ImageData {
  readonly format: 'png';
  readonly mime_type: 'image/png';
  readonly data_base64: string;
  readonly width: number;
  readonly height: number;
  readonly origin_x: number;
  readonly origin_y: number;
  readonly annotated: boolean;
}

interface StoredMark {
  readonly markId: string;
  readonly label: string;
  readonly bounds: Bounds;
  readonly annotationBounds: Bounds;
  readonly target: Readonly<Record<string, unknown>>;
}

interface StoredObservation {
  readonly observationId: string;
  readonly observationHash: string;
  readonly workspaceId: string;
  readonly ownerKey: string;
  readonly expiresAtMs: number;
  readonly expiresAt: string;
  readonly image: ImageData;
  readonly marks: readonly StoredMark[];
  readonly uiParameters: Readonly<Record<string, unknown>>;
}

export class SetOfMarksObservationStore {
  private readonly observations = new Map<string, StoredObservation>();

  public get(observationId: string): StoredObservation | undefined { return this.observations.get(observationId); }
  public set(observation: StoredObservation): void { this.observations.set(observation.observationId, observation); }
  public delete(observationId: string): void { this.observations.delete(observationId); }
  public pruneExpired(now: number): void {
    for (const [id, observation] of this.observations) if (now >= observation.expiresAtMs) this.observations.delete(id);
  }
}

export interface SetOfMarksOptions {
  readonly now?: () => number;
  readonly defaultTtlSeconds?: number;
  readonly maxTtlSeconds?: number;
  readonly store?: SetOfMarksObservationStore;
  readonly ownerKey?: string;
}

export class SetOfMarksService {
  private readonly now: () => number;
  private readonly defaultTtlSeconds: number;
  private readonly maxTtlSeconds: number;
  private readonly store: SetOfMarksObservationStore;
  private readonly ownerKey: string;

  public constructor(
    private readonly capabilities: CapabilityService | undefined,
    options: SetOfMarksOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.defaultTtlSeconds = clamp(options.defaultTtlSeconds ?? 120, 1, 300);
    this.maxTtlSeconds = clamp(options.maxTtlSeconds ?? 300, this.defaultTtlSeconds, 300);
    this.store = options.store ?? new SetOfMarksObservationStore();
    this.ownerKey = options.ownerKey?.trim() || 'local';
  }

  public async capture(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const parsed = parseCaptureInput(input, this.defaultTtlSeconds, this.maxTtlSeconds);
    if (!parsed.ok) return parsed;
    if (signal?.aborted) return cancelledResult('Visual capture');
    this.pruneExpired();

    const observed = await this.executeCapability('accessibility', {
      action: 'observe',
      parameters: {
        ...parsed.value.uiParameters,
        max_depth: parsed.value.maxDepth,
        max_items: Math.min(parsed.value.maxMarks * 4, 2_000),
      },
    }, signal, authorization);
    if (!observed.ok) return observed;
    if (signal?.aborted) return cancelledResult('Visual capture');
    const observedMarks = extractMarks(observed.value, parsed.value.maxMarks);

    const captured = await this.executeCapability('vision', parsed.value.visionInput, signal, authorization);
    if (!captured.ok) return captured;
    if (signal?.aborted) return cancelledResult('Visual capture');
    const sourceImage = normalizeImage(captured.value, false);
    if (!sourceImage.ok) return sourceImage;

    const marks = applyImageOrigin(observedMarks, sourceImage.value.origin_x, sourceImage.value.origin_y);
    const annotationInput = {
      action: 'annotate',
      image_base64: sourceImage.value.data_base64,
      marks: marks.map((mark) => ({ mark_id: mark.markId, label: mark.label, bounds: mark.annotationBounds })),
    };
    const annotated = await this.executeCapability('vision', annotationInput, signal, authorization);
    if (signal?.aborted) return cancelledResult('Visual capture');
    const annotatedImage = annotated.ok ? normalizeImage(annotated.value, true) : undefined;
    const image = annotatedImage?.ok === true
      ? { ...annotatedImage.value, origin_x: sourceImage.value.origin_x, origin_y: sourceImage.value.origin_y }
      : sourceImage.value;
    const now = this.now();
    const expiresAtMs = now + parsed.value.ttlSeconds * 1_000;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const observationId = randomUUID();
    const observationHash = createObservationHash(image, marks);
    const observation: StoredObservation = {
      observationId,
      observationHash,
      workspaceId: parsed.value.workspaceId,
      ownerKey: this.ownerKey,
      expiresAtMs,
      expiresAt,
      image,
      marks,
      uiParameters: parsed.value.uiParameters,
    };
    this.store.set(observation);
    return ok(toPublicObservation(observation));
  }

  public async act(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const parsed = parseActionInput(input);
    if (!parsed.ok) return parsed;
    if (signal?.aborted) return cancelledResult('Marked UI action');
    const observation = this.store.get(parsed.value.observationId);
    if (observation === undefined) return err(appError('INVALID_INPUT', 'The visual observation is unknown or stale'));
    if (this.now() >= observation.expiresAtMs) {
      this.store.delete(observation.observationId);
      return err(appError('INVALID_INPUT', 'The visual observation has expired'));
    }
    if (observation.ownerKey !== this.ownerKey) return err(appError('PERMISSION_DENIED', 'The visual observation belongs to another MCP session'));
    if (observation.workspaceId !== parsed.value.workspaceId) return err(appError('PERMISSION_DENIED', 'The visual observation belongs to another workspace'));
    if (parsed.value.observationHash !== undefined && parsed.value.observationHash !== observation.observationHash) return err(appError('INVALID_INPUT', 'The visual observation hash is stale'));
    const mark = observation.marks.find((candidate) => candidate.markId === parsed.value.markId);
    if (mark === undefined) return err(appError('INVALID_INPUT', 'The visual mark is unknown or stale'));
    if (isMutatingAction(parsed.value.action) && !isApplicationAuthorized(authorization, parsed.value.userConfirmed) && parsed.value.dryRun !== true) {
      return err(appError('PERMISSION_REQUIRED', 'A marked UI action requires explicit user confirmation'));
    }
    if (parsed.value.dryRun === true) return ok({ dry_run: true, observationId: observation.observationId, markId: mark.markId, action: parsed.value.action });

    const targetParameters = { ...observation.uiParameters, ...mark.target };
    const current = await this.executeCapability('accessibility', { action: 'find_element', parameters: targetParameters }, signal, authorization);
    if (!current.ok) return current;
    if (signal?.aborted) return cancelledResult('Marked UI action');
    const actionParameters = parsed.value.value === undefined ? targetParameters : { ...targetParameters, value: parsed.value.value };
    return this.executeCapability('accessibility', { action: parsed.value.action, parameters: actionParameters, userConfirmed: parsed.value.userConfirmed }, signal, authorization);
  }

  public async resolvePoint(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<{ readonly x: number; readonly y: number }>> {
    const parsed = parseActionInput({ ...(isRecord(input) ? input : {}), action: 'read_value' });
    if (!parsed.ok) return parsed;
    if (signal?.aborted) return cancelledResult('Marked UI target resolution');
    const observation = this.store.get(parsed.value.observationId);
    if (observation === undefined) return err(appError('INVALID_INPUT', 'The visual observation is unknown or stale'));
    if (this.now() >= observation.expiresAtMs) {
      this.store.delete(observation.observationId);
      return err(appError('INVALID_INPUT', 'The visual observation has expired'));
    }
    if (observation.ownerKey !== this.ownerKey) return err(appError('PERMISSION_DENIED', 'The visual observation belongs to another MCP session'));
    if (observation.workspaceId !== parsed.value.workspaceId) return err(appError('PERMISSION_DENIED', 'The visual observation belongs to another workspace'));
    if (parsed.value.observationHash !== undefined && parsed.value.observationHash !== observation.observationHash) return err(appError('INVALID_INPUT', 'The visual observation hash is stale'));
    const mark = observation.marks.find((candidate) => candidate.markId === parsed.value.markId);
    if (mark === undefined) return err(appError('INVALID_INPUT', 'The visual mark is unknown or stale'));

    const targetParameters = { ...observation.uiParameters, ...mark.target };
    const current = await this.executeCapability('accessibility', { action: 'find_element', parameters: targetParameters }, signal, authorization);
    if (!current.ok) return current;
    if (signal?.aborted) return cancelledResult('Marked UI target resolution');
    const bounds = extractElementBounds(current.value);
    if (bounds === undefined) return err(appError('INVALID_INPUT', 'The marked UI target no longer has usable screen bounds'));
    return ok({ x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) });
  }

  private async executeCapability(tool: 'accessibility' | 'vision', input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (this.capabilities === undefined) return err(appError('INTERNAL_ERROR', 'Capability service is unavailable', true));
    return this.capabilities.execute(tool, input, signal, authorization);
  }

  private pruneExpired(): void {
    this.store.pruneExpired(this.now());
  }
}

interface CaptureInput {
  readonly workspaceId: string;
  readonly ttlSeconds: number;
  readonly maxMarks: number;
  readonly maxDepth: number;
  readonly uiParameters: Readonly<Record<string, unknown>>;
  readonly visionInput: Readonly<Record<string, unknown>>;
}

interface ActionInput {
  readonly workspaceId: string;
  readonly observationId: string;
  readonly markId: string;
  readonly observationHash?: string;
  readonly action: 'click' | 'focus' | 'read_value' | 'set_value' | 'select_item' | 'menu_select';
  readonly value?: string;
  readonly userConfirmed: boolean;
  readonly dryRun: boolean;
}

function parseCaptureInput(value: unknown, defaultTtlSeconds: number, maxTtlSeconds: number): Result<CaptureInput> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'Set-of-Marks capture input must be an object'));
  const workspaceId = readNonEmptyString(value.workspaceId);
  if (workspaceId === undefined) return err(appError('INVALID_INPUT', 'workspaceId is required for visual observations'));
  const capture = value.capture === undefined ? 'display' : value.capture;
  if (capture !== 'display' && capture !== 'region' && capture !== 'window') return err(appError('INVALID_INPUT', 'Capture target is invalid'));
  const ttlSeconds = value.ttl_seconds === undefined ? defaultTtlSeconds : value.ttl_seconds;
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > maxTtlSeconds) return err(appError('INVALID_INPUT', 'Observation TTL is invalid'));
  const maxMarks = value.max_marks === undefined ? 100 : value.max_marks;
  if (typeof maxMarks !== 'number' || !Number.isInteger(maxMarks) || maxMarks < 1 || maxMarks > 500) return err(appError('INVALID_INPUT', 'Mark limit is invalid'));
  const maxDepth = value.max_depth === undefined ? 4 : value.max_depth;
  if (typeof maxDepth !== 'number' || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 12) return err(appError('INVALID_INPUT', 'UI tree depth is invalid'));
  const uiParameters: Record<string, unknown> = {};
  if (isRecord(value.app)) Object.assign(uiParameters, value.app);
  if (typeof value.window_index === 'number') uiParameters.window_index = value.window_index;
  const visionInput: Record<string, unknown> = { action: `capture_${capture}` };
  if (isRecord(value.region)) visionInput.region = value.region;
  if (isRecord(value.app)) visionInput.app = value.app;
  if (typeof value.window_index === 'number') visionInput.window_index = value.window_index;
  if (typeof value.display_id === 'string') visionInput.display_id = value.display_id;
  return ok({ workspaceId, ttlSeconds, maxMarks, maxDepth, uiParameters, visionInput });
}

function parseActionInput(value: unknown): Result<ActionInput> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'Marked UI action input must be an object'));
  const workspaceId = readNonEmptyString(value.workspaceId);
  const observationId = readNonEmptyString(value.observationId);
  const markId = readNonEmptyString(value.markId);
  if (workspaceId === undefined || observationId === undefined || markId === undefined) return err(appError('INVALID_INPUT', 'workspaceId, observationId, and markId are required'));
  const action = value.action === undefined ? 'click' : value.action;
  const actions = ['click', 'focus', 'read_value', 'set_value', 'select_item', 'menu_select'] as const;
  if (!actions.includes(action as typeof actions[number])) return err(appError('INVALID_INPUT', 'Marked UI action is invalid'));
  const observationHash = value.observationHash === undefined ? undefined : readNonEmptyString(value.observationHash);
  if (value.observationHash !== undefined && observationHash === undefined) return err(appError('INVALID_INPUT', 'Observation hash is invalid'));
  const selectedValue = value.value;
  if (selectedValue !== undefined && (typeof selectedValue !== 'string' || selectedValue.length > 1_000_000)) return err(appError('INVALID_INPUT', 'Marked UI value is invalid'));
  return ok({ workspaceId, observationId, markId, ...(observationHash === undefined ? {} : { observationHash }), action: action as ActionInput['action'], ...(selectedValue === undefined ? {} : { value: selectedValue }), userConfirmed: value.userConfirmed === true, dryRun: value.dry_run === true });
}

function extractMarks(value: unknown, maxMarks: number): readonly StoredMark[] {
  if (!isRecord(value) || !Array.isArray(value.elements)) return [];
  const marks: StoredMark[] = [];
  for (const entry of value.elements) {
    if (marks.length >= maxMarks || !isRecord(entry)) continue;
    const element = isRecord(entry.element) ? entry.element : entry;
    const bounds = readBounds(element.bounds);
    if (bounds === undefined || element.enabled === false || element.offscreen === true) continue;
    const name = readNonEmptyString(element.name);
    const automationId = readNonEmptyString(element.automation_id);
    const controlType = readNonEmptyString(element.control_type);
    const label = name ?? automationId ?? controlType ?? `element-${marks.length + 1}`;
    const target: Record<string, unknown> = {};
    if (name !== undefined) target.name = name;
    if (automationId !== undefined) target.automation_id = automationId;
    marks.push({
      markId: `m${marks.length + 1}`,
      label,
      bounds,
      annotationBounds: bounds,
      target,
    });
  }
  return marks;
}

function applyImageOrigin(marks: readonly StoredMark[], originX: number, originY: number): readonly StoredMark[] {
  if (originX === 0 && originY === 0) return marks;
  return marks.map((mark) => ({
    ...mark,
    annotationBounds: {
      ...mark.annotationBounds,
      x: mark.annotationBounds.x - Math.round(originX),
      y: mark.annotationBounds.y - Math.round(originY),
    },
  }));
}

function normalizeImage(value: unknown, annotated: boolean): Result<ImageData> {
  const image = isRecord(value) && isRecord(value.image) ? value.image : value;
  if (!isRecord(image) || image.format !== 'png' || image.mime_type !== 'image/png' || typeof image.data_base64 !== 'string' || image.data_base64.length === 0) {
    return err(appError('INTERNAL_ERROR', 'Vision did not return a PNG image', true));
  }
  const width = image.width;
  const height = image.height;
  if (typeof width !== 'number' || !Number.isInteger(width) || width < 1 || typeof height !== 'number' || !Number.isInteger(height) || height < 1) {
    return err(appError('INTERNAL_ERROR', 'Vision returned invalid image dimensions', true));
  }
  return ok({
    format: 'png',
    mime_type: 'image/png',
    data_base64: image.data_base64,
    width,
    height,
    origin_x: typeof image.origin_x === 'number' ? image.origin_x : 0,
    origin_y: typeof image.origin_y === 'number' ? image.origin_y : 0,
    annotated,
  });
}

function createObservationHash(image: ImageData, marks: readonly StoredMark[]): string {
  const imageHash = createHash('sha256').update(image.data_base64).digest('hex');
  return createHash('sha256').update(JSON.stringify({ imageHash, marks: marks.map((mark) => ({ markId: mark.markId, bounds: mark.bounds, target: mark.target })) })).digest('hex');
}

function toPublicObservation(observation: StoredObservation): Record<string, unknown> {
  return {
    observationId: observation.observationId,
    observationHash: observation.observationHash,
    expiresAt: observation.expiresAt,
    image: observation.image,
    marks: observation.marks.map((mark) => ({ markId: mark.markId, label: mark.label, bounds: mark.bounds, target: mark.target })),
  };
}

function extractElementBounds(value: unknown): Bounds | undefined {
  if (!isRecord(value)) return undefined;
  const element = isRecord(value.element) ? value.element : value;
  return readBounds(element.bounds);
}

function readBounds(value: unknown): Bounds | undefined {
  if (!isRecord(value)) return undefined;
  const x = toFiniteNumber(value.x);
  const y = toFiniteNumber(value.y);
  const width = toFiniteNumber(value.width);
  const height = toFiniteNumber(value.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function isMutatingAction(action: ActionInput['action']): boolean {
  return action === 'click' || action === 'set_value' || action === 'select_item' || action === 'menu_select';
}

function cancelledResult(operation: string): Result<never> {
  return err(appError('PROCESS_TIMEOUT', `${operation} was cancelled`, true));
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
