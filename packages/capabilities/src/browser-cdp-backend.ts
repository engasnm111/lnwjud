import { appError, err, isApplicationAuthorized, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';

export interface BrowserCdpTab {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export interface BrowserCdpProtocol {
  status(signal?: AbortSignal): Promise<{
    readonly ready: boolean;
    readonly port: number;
    readonly browserInstalled?: boolean;
    readonly readinessReason?: 'browser_ready' | 'browser_not_installed' | 'browser_not_running' | 'probe_failed';
  }>;
  listTabs(signal?: AbortSignal): Promise<readonly BrowserCdpTab[]>;
  newTab(url: string, signal?: AbortSignal): Promise<BrowserCdpTab>;
  closeTab(tabId: string, signal?: AbortSignal): Promise<unknown>;
  request(tabId: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface BrowserCdpBackendOptions {
  readonly protocol?: BrowserCdpProtocol;
  readonly launcher?: (url: string | undefined, signal?: AbortSignal) => Promise<Result<unknown>>;
}

type BrowserAction = 'launch' | 'status' | 'list_tabs' | 'new_tab' | 'activate_tab' | 'close_tab' | 'navigate' | 'evaluate' | 'query' | 'click' | 'type' | 'wait' | 'screenshot';

interface BrowserRequest {
  readonly action?: BrowserAction;
  readonly parameters: Record<string, unknown>;
  readonly steps?: readonly { readonly action: BrowserAction; readonly parameters: Record<string, unknown> }[];
  readonly tabId?: string;
  readonly allowProtectedTabAction: boolean;
  readonly timeoutSeconds: number;
  readonly dryRun: boolean;
  readonly userConfirmed: boolean;
}

const BROWSER_ACTIONS: readonly BrowserAction[] = ['launch', 'status', 'list_tabs', 'new_tab', 'activate_tab', 'close_tab', 'navigate', 'evaluate', 'query', 'click', 'type', 'wait', 'screenshot'];
const TARGET_SCOPED_ACTIONS = new Set<BrowserAction>(['activate_tab', 'close_tab', 'navigate', 'evaluate', 'query', 'click', 'type', 'wait', 'screenshot']);
const PROTECTED_TAB_MUTATIONS = new Set<BrowserAction>(['close_tab', 'navigate', 'evaluate', 'click', 'type']);
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 3600;

export class BrowserCdpBackend implements CapabilityBackend {
  private readonly protocol: BrowserCdpProtocol;
  private readonly launcher: ((url: string | undefined, signal?: AbortSignal) => Promise<Result<unknown>>) | undefined;
  private startInFlight: Promise<Result<unknown>> | null = null;

  public constructor(options: BrowserCdpBackendOptions = {}) {
    this.protocol = options.protocol ?? new NodeBrowserCdpProtocol();
    this.launcher = options.launcher;
  }

  public async ensureStarted(url?: string, signal?: AbortSignal): Promise<Result<unknown>> {
    const current = await this.protocol.status(signal);
    if (current.ready) return ok({ ready: true, port: current.port, launched: false });
    if (this.launcher === undefined) return err(appError('INTERNAL_ERROR', 'Browser launcher is not configured', true));
    let launch = this.startInFlight;
    if (launch === null) {
      launch = this.launcher(url);
      this.startInFlight = launch;
      void launch.then(
        () => { if (this.startInFlight === launch) this.startInFlight = null; },
        () => { if (this.startInFlight === launch) this.startInFlight = null; },
      );
    }
    return waitForBrowserStart(launch, signal);
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const aborted = cancellationResult(signal);
    if (aborted !== null) return aborted;
    const parsed = parseBrowserRequest(input);
    if (!parsed.ok) return parsed;
    try {
      const result = parsed.value.steps !== undefined
        ? await this.executeSteps(parsed.value, signal, authorization)
        : parsed.value.action === undefined
          ? err(appError('INVALID_INPUT', 'DOM action is required'))
          : await this.executeAction(parsed.value, parsed.value.action, parsed.value.parameters, signal, authorization);
      return cancellationResult(signal) ?? result;
    } catch {
      return cancellationResult(signal) ?? err(appError('INTERNAL_ERROR', 'Browser CDP operation failed', true));
    }
  }

  private async executeSteps(request: BrowserRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const values: unknown[] = [];
    for (const step of request.steps ?? []) {
      const aborted = cancellationResult(signal);
      if (aborted !== null) return aborted;
      const result = await this.executeAction(request, step.action, step.parameters, signal, authorization);
      if (!result.ok) return result;
      const abortedAfterStep = cancellationResult(signal);
      if (abortedAfterStep !== null) return abortedAfterStep;
      values.push(result.value);
    }
    return ok({ steps: values });
  }

  private async executeAction(
    request: BrowserRequest,
    action: BrowserAction,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    const aborted = cancellationResult(signal);
    if (aborted !== null) return aborted;
    if (request.dryRun) return ok({ dry_run: true, action, parameters, ...(request.tabId === undefined ? {} : { tab_id: request.tabId }) });
    if (!isReadOnlyBrowserAction(action) && !isApplicationAuthorized(authorization, request.userConfirmed)) {
      return err(appError('PERMISSION_REQUIRED', 'Browser actions that can change local or remote state require explicit user confirmation'));
    }
    if (action !== 'status' && action !== 'launch') {
      const started = await this.ensureStarted(undefined, signal);
      if (!started.ok) return started;
    }
    switch (action) {
      case 'status': return ok(await this.protocol.status(signal));
      case 'launch': return this.ensureStarted(readString(parameters, 'url'), signal);
      case 'list_tabs': return ok({ tabs: await this.protocol.listTabs(signal) });
      case 'new_tab': return ok(await this.protocol.newTab(readString(parameters, 'url') ?? 'about:blank', signal));
      case 'activate_tab': return this.withTab(request, action, async (tab) => {
        await this.protocol.request(tab.id, 'Page.bringToFront', {}, signal);
        return ok({ activated: true, tab_id: tab.id });
      }, signal);
      case 'close_tab': return this.withTab(request, action, async (tab) => ok(await this.protocol.closeTab(tab.id, signal)), signal);
      case 'navigate': return this.withTab(request, action, async (tab) => this.navigateProtocol(tab.id, readString(parameters, 'url') ?? '', signal), signal);
      case 'evaluate': {
        const expression = readString(parameters, 'expression');
        return expression === undefined
          ? err(appError('INVALID_INPUT', 'JavaScript expression is required'))
          : this.withTab(request, action, async (tab) => this.evaluateProtocol(tab.id, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, signal), signal);
      }
      case 'query': return this.withTab(request, action, async (tab) => this.evaluateProtocol(tab.id, 'Runtime.evaluate', { expression: queryScript(readString(parameters, 'selector') ?? ''), returnByValue: true, awaitPromise: true }, signal), signal);
      case 'click': return this.withTab(request, action, async (tab) => this.evaluateProtocol(tab.id, 'Runtime.evaluate', { expression: clickScript(readString(parameters, 'selector') ?? ''), returnByValue: true, awaitPromise: true }, signal), signal);
      case 'type': return this.withTab(request, action, async (tab) => this.typeProtocol(tab.id, parameters, signal), signal);
      case 'wait': return this.waitFor(request, parameters, signal);
      case 'screenshot': return this.withTab(request, action, async (tab) => {
        const result = await this.protocol.request(tab.id, 'Page.captureScreenshot', { format: 'png' }, signal);
        const data = readScreenshotData(result);
        return data === undefined ? err(appError('INTERNAL_ERROR', 'Browser screenshot response was invalid', true)) : ok({ format: 'png', data_base64: data });
      }, signal);
    }
  }

  private async waitFor(request: BrowserRequest, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const selector = readString(parameters, 'selector');
    const expression = readString(parameters, 'expression');
    if (selector === undefined && expression === undefined) return err(appError('INVALID_INPUT', 'Wait requires a selector or expression'));
    const deadline = Date.now() + Math.min(request.timeoutSeconds, MAX_TIMEOUT_SECONDS) * 1000;
    while (Date.now() <= deadline) {
      const aborted = cancellationResult(signal);
      if (aborted !== null) return aborted;
      const result = await this.withTab(request, 'wait', async (tab) => this.evaluateProtocol(tab.id, 'Runtime.evaluate', {
        expression: selector === undefined ? expression! : `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
        returnByValue: true,
        awaitPromise: true,
      }, signal), signal);
      if (!result.ok) return result;
      if (result.value === true) return ok({ ready: true });
      await delay(Math.min(readNumber(parameters, 'poll_interval_seconds') ?? 0.1, 1) * 1000, signal);
    }
    return ok({ ready: false, timed_out: true });
  }

  private async withTab(
    request: BrowserRequest,
    action: BrowserAction,
    callback: (tab: BrowserCdpTab) => Promise<Result<unknown>>,
    signal?: AbortSignal,
  ): Promise<Result<unknown>> {
    if (request.tabId === undefined) {
      return err(appError('INVALID_INPUT', `${action} requires tab_id; call list_tabs or new_tab first`));
    }
    const tabs = await this.protocol.listTabs(signal);
    const aborted = cancellationResult(signal);
    if (aborted !== null) return aborted;
    const tab = tabs.find((candidate) => candidate.id === request.tabId);
    if (tab === undefined) return err(appError('INVALID_INPUT', 'The requested managed Chrome tab was not found'));
    const protectedDecision = authorizeProtectedTabAction(request, action, tab);
    if (!protectedDecision.ok) return protectedDecision;
    return callback(tab);
  }

  private async navigateProtocol(tabId: string, url: string, signal?: AbortSignal): Promise<Result<unknown>> {
    try {
      return readNavigationResult(await this.protocol.request(tabId, 'Page.navigate', { url }, signal));
    } catch {
      return err(appError('INTERNAL_ERROR', 'Browser CDP navigation request failed', true));
    }
  }

  private async evaluateProtocol(tabId: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    try {
      return ok(readCdpValue(await this.protocol.request(tabId, method, params, signal)));
    } catch {
      return err(appError('INTERNAL_ERROR', 'Browser CDP request failed', true));
    }
  }

  private async typeProtocol(tabId: string, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const selector = readString(parameters, 'selector');
    const text = readString(parameters, 'text') ?? '';
    const clear = parameters.clear === true;

    const inspectScript = `(() => {
      const el = ${selector !== undefined && selector.length > 0 ? `document.querySelector(${JSON.stringify(selector)})` : 'document.activeElement'};
      if (!el || (el === document.body && ${selector === undefined || selector.length === 0})) return { ok: false, error: 'Element not found' };
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      }
      if (typeof el.focus === 'function') {
        el.focus();
      }
      const isInputOrTextarea = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      const isContentEditable = !!(
        el.isContentEditable
        || el.getAttribute('contenteditable') === 'true'
        || el.getAttribute('contenteditable') === ''
        || el.classList.contains('ProseMirror')
        || el.getAttribute('role') === 'textbox'
      );
      if (isContentEditable || !isInputOrTextarea) {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          if (${clear}) {
            range.selectNodeContents(el);
          } else {
            range.selectNodeContents(el);
            range.collapse(false);
          }
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return { ok: true, isContentEditable: true, tag: el.tagName, text: el.innerText ?? el.textContent ?? '' };
      }
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) {
        setter.call(el, ${JSON.stringify(text)});
      } else {
        el.value = ${JSON.stringify(text)};
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, isContentEditable: false, value: el.value, tag: el.tagName };
    })()`;

    const inspectResult = await this.evaluateProtocol(tabId, 'Runtime.evaluate', {
      expression: inspectScript,
      returnByValue: true,
      awaitPromise: true,
    }, signal);

    if (!inspectResult.ok) return inspectResult;
    const inspectValue = inspectResult.value;
    if (isRecord(inspectValue) && inspectValue.ok === false) {
      return ok({ ok: false, error: inspectValue.error ?? 'Element not found', ...(selector === undefined ? {} : { selector }) });
    }

    if (isRecord(inspectValue) && inspectValue.isContentEditable === true) {
      try {
        await this.protocol.request(tabId, 'Input.insertText', { text }, signal);
      } catch {
        return err(appError('INTERNAL_ERROR', 'Browser CDP Input.insertText failed', true));
      }

      const verifyScript = `(() => {
        const el = ${selector !== undefined && selector.length > 0 ? `document.querySelector(${JSON.stringify(selector)})` : 'document.activeElement'};
        if (!el) return { ok: false, error: 'Element not found after typing' };
        return { ok: true, text: el.innerText ?? el.textContent ?? '' };
      })()`;
      const verifyResult = await this.evaluateProtocol(tabId, 'Runtime.evaluate', {
        expression: verifyScript,
        returnByValue: true,
        awaitPromise: true,
      }, signal);
      if (!verifyResult.ok) return verifyResult;
      const verifyValue = verifyResult.value;
      if (!isRecord(verifyValue) || verifyValue.ok === false || typeof verifyValue.text !== 'string') {
        return err(appError('INTERNAL_ERROR', 'Browser CDP text insertion could not be verified', true));
      }

      const beforeText = typeof inspectValue.text === 'string' ? inspectValue.text : '';
      const verifiedText = verifyValue.text;
      const mutationObserved = text.length === 0
        ? (!clear || verifiedText.length === 0)
        : verifiedText !== beforeText || (clear && verifiedText === text);
      if (!mutationObserved) {
        return err(appError('INTERNAL_ERROR', 'Browser CDP text insertion did not update the target', true));
      }

      return ok({
        ok: true,
        typed: true,
        isContentEditable: true,
        tag: inspectValue.tag,
        text: verifiedText,
        value: verifiedText,
      });
    }

    const value = isRecord(inspectValue) && 'value' in inspectValue ? inspectValue.value : text;
    return ok({
      ok: true,
      typed: true,
      isContentEditable: false,
      value,
      text: typeof value === 'string' ? value : text,
    });
  }
}

function parseBrowserRequest(value: unknown): Result<BrowserRequest> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'DOM input must be an object'));
  const actionValue = value.action;
  const action = actionValue === undefined ? undefined : isBrowserAction(actionValue) ? actionValue : null;
  if (action === null) return err(appError('INVALID_INPUT', 'DOM action is invalid'));

  const parametersValue = value.parameters;
  const rawParameters = parametersValue === undefined ? {} : parametersValue;
  if (!isRecord(rawParameters)) return err(appError('INVALID_INPUT', 'DOM parameters must be an object'));

  const topLevelTabId = parseOptionalTabId(value.tab_id);
  if (!topLevelTabId.ok) return topLevelTabId;
  const nestedTabId = parseOptionalTabId(rawParameters.tab_id);
  if (!nestedTabId.ok) return nestedTabId;
  if (topLevelTabId.value !== undefined && nestedTabId.value !== undefined && topLevelTabId.value !== nestedTabId.value) {
    return err(appError('INVALID_INPUT', 'Conflicting top-level and parameters.tab_id values'));
  }
  const tabId = topLevelTabId.value ?? nestedTabId.value;
  const parameters = nestedTabId.value === undefined ? rawParameters : omitKey(rawParameters, 'tab_id');

  const allowProtectedTabAction = value.allow_protected_tab_action === undefined ? false : value.allow_protected_tab_action;
  if (typeof allowProtectedTabAction !== 'boolean') return err(appError('INVALID_INPUT', 'Protected-tab override flag is invalid'));
  const timeoutSeconds = value.timeout_seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : value.timeout_seconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0.1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) return err(appError('INVALID_INPUT', 'DOM timeout is invalid'));
  const dryRun = value.dry_run === undefined ? false : value.dry_run;
  if (typeof dryRun !== 'boolean') return err(appError('INVALID_INPUT', 'Dry-run flag is invalid'));

  const stepsValue = value.steps;
  if (stepsValue !== undefined && (!Array.isArray(stepsValue) || stepsValue.length < 1 || stepsValue.length > 100)) return err(appError('INVALID_INPUT', 'DOM steps must contain 1 to 100 items'));
  if ((action === undefined) === (stepsValue === undefined)) return err(appError('INVALID_INPUT', 'Provide exactly one of DOM action or steps'));

  const normalizedSteps: { readonly action: BrowserAction; readonly parameters: Record<string, unknown> }[] = [];
  if (stepsValue !== undefined) {
    if (tabId === undefined) return err(appError('INVALID_INPUT', 'DOM steps require top-level tab_id; call list_tabs or new_tab first'));
    if (nestedTabId.value !== undefined) return err(appError('INVALID_INPUT', 'DOM steps require top-level tab_id, not parameters.tab_id'));
    for (const step of stepsValue) {
      if (!isRecord(step) || !isBrowserAction(step.action)) return err(appError('INVALID_INPUT', 'DOM step is invalid'));
      const stepParameters = step.parameters === undefined ? {} : step.parameters;
      if (!isRecord(stepParameters)) return err(appError('INVALID_INPUT', 'DOM step parameters are invalid'));
      if ('tab_id' in stepParameters) return err(appError('INVALID_INPUT', 'Use the top-level tab_id for the whole DOM steps batch'));
      normalizedSteps.push({ action: step.action, parameters: stepParameters });
    }
  }

  const actions = normalizedSteps.length > 0 ? normalizedSteps.map((step) => step.action) : action === undefined ? [] : [action];
  if (actions.some((candidate) => TARGET_SCOPED_ACTIONS.has(candidate)) && tabId === undefined) {
    return err(appError('INVALID_INPUT', 'Target-scoped DOM actions require tab_id; call list_tabs or new_tab first'));
  }

  return ok({
    ...(action === undefined ? {} : { action }),
    parameters,
    ...(stepsValue === undefined ? {} : { steps: normalizedSteps }),
    ...(tabId === undefined ? {} : { tabId }),
    allowProtectedTabAction,
    timeoutSeconds,
    dryRun,
    userConfirmed: value.userConfirmed === true,
  });
}

function parseOptionalTabId(value: unknown): Result<string | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) return err(appError('INVALID_INPUT', 'Tab ID is invalid'));
  return ok(value.trim());
}

function omitKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function authorizeProtectedTabAction(request: BrowserRequest, action: BrowserAction, tab: BrowserCdpTab): Result<void> {
  if (!PROTECTED_TAB_MUTATIONS.has(action) || !isProtectedAgentTab(tab)) return ok(undefined);
  if (request.allowProtectedTabAction && request.userConfirmed) return ok(undefined);
  return err(appError(
    'PERMISSION_DENIED',
    'Refusing to mutate a protected ChatGPT tab without allow_protected_tab_action=true and explicit user confirmation',
  ));
}

function isProtectedAgentTab(tab: BrowserCdpTab): boolean {
  try {
    const hostname = new URL(tab.url).hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'chatgpt.com'
      || hostname.endsWith('.chatgpt.com')
      || hostname === 'chat.openai.com'
      || hostname.endsWith('.chat.openai.com');
  } catch {
    return false;
  }
}

function isReadOnlyBrowserAction(action: BrowserAction): boolean {
  return action === 'status' || action === 'list_tabs' || action === 'query' || action === 'wait' || action === 'screenshot';
}

function isBrowserAction(value: unknown): value is BrowserAction {
  return typeof value === 'string' && BROWSER_ACTIONS.some((action) => action === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  return typeof result === 'string' ? result : undefined;
}

function readNumber(value: Record<string, unknown>, key: string): number | undefined {
  const result = value[key];
  return typeof result === 'number' && Number.isFinite(result) ? result : undefined;
}

function readNavigationResult(response: unknown): Result<unknown> {
  if (!isRecord(response)) return err(appError('INTERNAL_ERROR', 'Browser navigation response was invalid', true));
  if (isRecord(response.error)) return err(appError('INTERNAL_ERROR', 'Browser CDP navigation request failed', true));
  if (!isRecord(response.result)) return err(appError('INTERNAL_ERROR', 'Browser navigation response was invalid', true));

  const frameId = response.result.frameId;
  const loaderId = response.result.loaderId;
  const errorText = response.result.errorText;
  const isDownload = response.result.isDownload;
  if (typeof frameId !== 'string' || frameId.length === 0) return err(appError('INTERNAL_ERROR', 'Browser navigation response was invalid', true));
  if (loaderId !== undefined && typeof loaderId !== 'string') return err(appError('INTERNAL_ERROR', 'Browser navigation response was invalid', true));
  if (errorText !== undefined && typeof errorText !== 'string') return err(appError('INTERNAL_ERROR', 'Browser navigation response was invalid', true));
  if (isDownload !== undefined && typeof isDownload !== 'boolean') return err(appError('INTERNAL_ERROR', 'Browser navigation response was invalid', true));
  if (typeof errorText === 'string' && errorText.length > 0) return err(appError('INTERNAL_ERROR', 'Browser navigation failed', true));

  return ok({
    navigation_requested: true,
    navigation_complete: false,
    frame_id: frameId,
    ...(loaderId === undefined ? {} : { loader_id: loaderId }),
    ...(isDownload === undefined ? {} : { is_download: isDownload }),
  });
}

function readCdpValue(response: unknown): unknown {
  if (!isRecord(response)) return undefined;
  const outerResult = response.result;
  if (!isRecord(outerResult)) return undefined;
  const remoteResult = outerResult.result;
  if (!isRecord(remoteResult)) return undefined;
  if ('exceptionDetails' in remoteResult) return undefined;
  return 'value' in remoteResult ? remoteResult.value : undefined;
}

function readScreenshotData(response: unknown): string | undefined {
  if (!isRecord(response) || !isRecord(response.result)) return undefined;
  return typeof response.result.data === 'string' ? response.result.data : undefined;
}

function queryScript(selector: string): string {
  return `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return {ok:false}; const r=el.getBoundingClientRect(); return {ok:true,text:el.innerText||el.value||'',tag:el.tagName,disabled:!!el.disabled,frame:{x:r.x,y:r.y,width:r.width,height:r.height}}; })()`;
}

function clickScript(selector: string): string {
  return `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return {ok:false}; el.scrollIntoView({block:'center',inline:'center'}); el.click(); return {ok:true}; })()`;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForBrowserStart(start: Promise<Result<unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
  if (signal === undefined) return start;
  const cancelled = cancellationResult(signal);
  if (cancelled !== null) return Promise.resolve(cancelled);

  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      resolve(err(appError('PROCESS_TIMEOUT', 'DOM operation was cancelled before the next side effect', true)));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void start.then(
      (result) => { cleanup(); resolve(result); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

function cancellationResult(signal: AbortSignal | undefined): Result<never> | null {
  return signal?.aborted === true
    ? err(appError('PROCESS_TIMEOUT', 'DOM operation was cancelled before the next side effect', true))
    : null;
}
