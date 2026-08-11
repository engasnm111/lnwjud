import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';

export interface BrowserCdpTab {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export interface BrowserCdpProtocol {
  status(): Promise<{ readonly ready: boolean; readonly port: number }>;
  listTabs(): Promise<readonly BrowserCdpTab[]>;
  newTab(url: string): Promise<BrowserCdpTab>;
  closeTab(tabId: string): Promise<unknown>;
  request(tabId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface BrowserCdpBackendOptions {
  readonly protocol?: BrowserCdpProtocol;
  readonly launcher?: (url: string | undefined) => Promise<Result<unknown>>;
}

type BrowserAction = 'launch' | 'status' | 'list_tabs' | 'new_tab' | 'close_tab' | 'navigate' | 'evaluate' | 'query' | 'click' | 'type' | 'wait' | 'screenshot';

interface BrowserRequest {
  readonly action?: BrowserAction;
  readonly parameters: Record<string, unknown>;
  readonly steps?: readonly { readonly action: BrowserAction; readonly parameters: Record<string, unknown> }[];
  readonly tabId?: string;
  readonly timeoutSeconds: number;
  readonly dryRun: boolean;
}

const BROWSER_ACTIONS: readonly BrowserAction[] = ['launch', 'status', 'list_tabs', 'new_tab', 'close_tab', 'navigate', 'evaluate', 'query', 'click', 'type', 'wait', 'screenshot'];
const DEFAULT_TIMEOUT_SECONDS = 30;

export class BrowserCdpBackend implements CapabilityBackend {
  private readonly protocol: BrowserCdpProtocol;
  private readonly launcher: ((url: string | undefined) => Promise<Result<unknown>>) | undefined;

  public constructor(options: BrowserCdpBackendOptions = {}) {
    this.protocol = options.protocol ?? new NodeBrowserCdpProtocol();
    this.launcher = options.launcher;
  }

  public async execute(input: unknown): Promise<Result<unknown>> {
    const parsed = parseBrowserRequest(input);
    if (!parsed.ok) return parsed;
    if (parsed.value.steps !== undefined) return this.executeSteps(parsed.value);
    if (parsed.value.action === undefined) return err(appError('INVALID_INPUT', 'DOM action is required'));
    return this.executeAction(parsed.value, parsed.value.action, parsed.value.parameters);
  }

  private async executeSteps(request: BrowserRequest): Promise<Result<unknown>> {
    const values: unknown[] = [];
    for (const step of request.steps ?? []) {
      const result = await this.executeAction(request, step.action, step.parameters);
      if (!result.ok) return result;
      values.push(result.value);
    }
    return ok({ steps: values });
  }

  private async executeAction(request: BrowserRequest, action: BrowserAction, parameters: Record<string, unknown>): Promise<Result<unknown>> {
    if (request.dryRun) return ok({ dry_run: true, action, parameters });
    switch (action) {
      case 'status': return ok(await this.protocol.status());
      case 'launch':
        if (this.launcher === undefined) return err(appError('INTERNAL_ERROR', 'Browser launcher is not configured', true));
        return this.launcher(readString(parameters, 'url'));
      case 'list_tabs': return ok({ tabs: await this.protocol.listTabs() });
      case 'new_tab': return ok(await this.protocol.newTab(readString(parameters, 'url') ?? 'about:blank'));
      case 'close_tab': {
        const tabId = request.tabId ?? readString(parameters, 'tab_id');
        return tabId === undefined ? err(appError('INVALID_INPUT', 'Tab ID is required')) : ok(await this.protocol.closeTab(tabId));
      }
      case 'navigate': return this.withTab(request, parameters, async (tab) => this.evaluateProtocol(tab.id, 'Page.navigate', { url: readString(parameters, 'url') ?? '' }));
      case 'evaluate': {
        const expression = readString(parameters, 'expression');
        return expression === undefined ? err(appError('INVALID_INPUT', 'JavaScript expression is required')) : this.withTab(request, parameters, async (tab) => this.evaluateProtocol(tab.id, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }));
      }
      case 'query': return this.withTab(request, parameters, async (tab) => this.evaluateProtocol(tab.id, 'Runtime.evaluate', { expression: queryScript(readString(parameters, 'selector') ?? ''), returnByValue: true, awaitPromise: true }));
      case 'click': return this.withTab(request, parameters, async (tab) => this.evaluateProtocol(tab.id, 'Runtime.evaluate', { expression: clickScript(readString(parameters, 'selector') ?? ''), returnByValue: true, awaitPromise: true }));
      case 'type': return this.withTab(request, parameters, async (tab) => this.evaluateProtocol(tab.id, 'Runtime.evaluate', { expression: typeScript(readString(parameters, 'selector') ?? '', readString(parameters, 'text') ?? ''), returnByValue: true, awaitPromise: true }));
      case 'wait': return this.waitFor(request, parameters);
      case 'screenshot': return this.withTab(request, parameters, async (tab) => {
        const result = await this.protocol.request(tab.id, 'Page.captureScreenshot', { format: 'png' });
        const data = readScreenshotData(result);
        return data === undefined ? err(appError('INTERNAL_ERROR', 'Browser screenshot response was invalid', true)) : ok({ format: 'png', data_base64: data });
      });
    }
  }

  private async waitFor(request: BrowserRequest, parameters: Record<string, unknown>): Promise<Result<unknown>> {
    const selector = readString(parameters, 'selector');
    const expression = readString(parameters, 'expression');
    if (selector === undefined && expression === undefined) return err(appError('INVALID_INPUT', 'Wait requires a selector or expression'));
    const deadline = Date.now() + Math.min(request.timeoutSeconds, 300) * 1000;
    while (Date.now() <= deadline) {
      const result = await this.withTab(request, parameters, async (tab) => this.evaluateProtocol(tab.id, 'Runtime.evaluate', {
        expression: selector === undefined ? expression! : `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
        returnByValue: true,
        awaitPromise: true,
      }));
      if (!result.ok) return result;
      if (result.value === true) return ok({ ready: true });
      await delay(Math.min(readNumber(parameters, 'poll_interval_seconds') ?? 0.1, 1) * 1000);
    }
    return ok({ ready: false, timed_out: true });
  }

  private async withTab(request: BrowserRequest, parameters: Record<string, unknown>, callback: (tab: BrowserCdpTab) => Promise<Result<unknown>>): Promise<Result<unknown>> {
    const tabId = request.tabId ?? readString(parameters, 'tab_id');
    const tabs = await this.protocol.listTabs();
    const tab = tabId === undefined ? tabs[0] : tabs.find((candidate) => candidate.id === tabId);
    return tab === undefined ? err(appError('INVALID_INPUT', 'A managed Chrome tab is required')) : callback(tab);
  }

  private async evaluateProtocol(tabId: string, method: string, params: Record<string, unknown>): Promise<Result<unknown>> {
    try {
      return ok(readCdpValue(await this.protocol.request(tabId, method, params)));
    } catch {
      return err(appError('INTERNAL_ERROR', 'Browser CDP request failed', true));
    }
  }
}

function parseBrowserRequest(value: unknown): Result<BrowserRequest> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'DOM input must be an object'));
  const actionValue = value.action;
  const action = actionValue === undefined ? undefined : isBrowserAction(actionValue) ? actionValue : null;
  if (action === null) return err(appError('INVALID_INPUT', 'DOM action is invalid'));
  const parametersValue = value.parameters;
  const parameters = parametersValue === undefined ? {} : parametersValue;
  if (!isRecord(parameters)) return err(appError('INVALID_INPUT', 'DOM parameters must be an object'));
  const tabId = value.tab_id;
  if (tabId !== undefined && typeof tabId !== 'string') return err(appError('INVALID_INPUT', 'Tab ID is invalid'));
  const timeoutSeconds = value.timeout_seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : value.timeout_seconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0.1 || timeoutSeconds > 300) return err(appError('INVALID_INPUT', 'DOM timeout is invalid'));
  const dryRun = value.dry_run === undefined ? false : value.dry_run;
  if (typeof dryRun !== 'boolean') return err(appError('INVALID_INPUT', 'Dry-run flag is invalid'));
  const stepsValue = value.steps;
  if (stepsValue !== undefined && (!Array.isArray(stepsValue) || stepsValue.length < 1 || stepsValue.length > 100)) return err(appError('INVALID_INPUT', 'DOM steps must contain 1 to 100 items'));
  const normalizedSteps: { readonly action: BrowserAction; readonly parameters: Record<string, unknown> }[] = [];
  if (stepsValue !== undefined) {
    for (const step of stepsValue) {
      if (!isRecord(step) || !isBrowserAction(step.action)) return err(appError('INVALID_INPUT', 'DOM step is invalid'));
      const stepParameters = step.parameters === undefined ? {} : step.parameters;
      if (!isRecord(stepParameters)) return err(appError('INVALID_INPUT', 'DOM step parameters are invalid'));
      normalizedSteps.push({ action: step.action, parameters: stepParameters });
    }
  }
  return ok({ ...(action === undefined ? {} : { action }), parameters, ...(stepsValue === undefined ? {} : { steps: normalizedSteps }), ...(tabId === undefined ? {} : { tabId }), timeoutSeconds, dryRun });
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

function typeScript(selector: string, text: string): string {
  return `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return {ok:false}; el.focus(); const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set; if(setter) setter.call(el,${JSON.stringify(text)}); else el.value=${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true,value:el.value}; })()`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
