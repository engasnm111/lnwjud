import { describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { CapabilityService, CapabilityToolName } from '@lnwjud/capabilities';
import { SetOfMarksObservationStore, SetOfMarksService } from './set-of-marks-service.js';

const image = {
  format: 'png',
  mime_type: 'image/png',
  data_base64: 'cG5n',
  width: 800,
  height: 600,
  origin_x: 0,
  origin_y: 0,
};

describe('SetOfMarksService', () => {
  it('returns an expiring hashed observation with annotated PNG marks', async () => {
    const calls: Array<{ tool: CapabilityToolName; input: unknown }> = [];
    const capabilities: CapabilityService = {
      execute: async (tool, input): Promise<Result<unknown>> => {
        calls.push({ tool, input });
        if (tool === 'accessibility') {
          return ok({ elements: [
            { depth: 1, element: { name: 'Save', automation_id: 'save', control_type: 'Button', enabled: true, offscreen: false, bounds: { x: 20, y: 30, width: 100, height: 40 } } },
            { depth: 1, element: { name: 'Hidden', enabled: true, offscreen: true, bounds: { x: 1, y: 1, width: 20, height: 20 } } },
          ] });
        }
        if (tool === 'vision' && isRecord(input) && input.action === 'annotate') return ok({ ...image, annotated: true });
        return ok(image);
      },
    };
    const service = new SetOfMarksService(capabilities, { now: (): number => 1_000, defaultTtlSeconds: 30 });

    const result = await service.capture({
      workspaceId: 'ws-1',
      capture: 'display',
      display_id: 'DISPLAY1',
    });

    expect(result).toMatchObject({ ok: true, value: {
      observationId: expect.any(String),
      observationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expiresAt: '1970-01-01T00:00:31.000Z',
      image: { format: 'png', data_base64: 'cG5n', annotated: true },
      marks: [{ markId: 'm1', label: 'Save', bounds: { x: 20, y: 30, width: 100, height: 40 } }],
    } });
    expect(calls.map((call) => call.tool)).toEqual(['accessibility', 'vision', 'vision']);
    expect(calls[2]?.input).toMatchObject({ action: 'annotate', marks: [{ mark_id: 'm1', bounds: { x: 20, y: 30, width: 100, height: 40 } }] });
  });

  it('revalidates a mark and rejects unknown, stale, expired, or cross-workspace actions', async () => {
    let now = 1_000;
    const calls: Array<{ tool: CapabilityToolName; input: unknown }> = [];
    const capabilities: CapabilityService = {
      execute: async (tool, input): Promise<Result<unknown>> => {
        calls.push({ tool, input });
        if (tool === 'accessibility' && isRecord(input) && input.action === 'observe') {
          return ok({ elements: [{ element: { name: 'Save', automation_id: 'save', enabled: true, offscreen: false, bounds: { x: 20, y: 30, width: 100, height: 40 } } }] });
        }
        if (tool === 'accessibility' && isRecord(input) && input.action === 'find_element') return ok({ element: { name: 'Save', automation_id: 'save' } });
        if (tool === 'accessibility' && isRecord(input) && input.action === 'click') return ok({ clicked: true });
        return ok(image);
      },
    };
    const service = new SetOfMarksService(capabilities, { now: (): number => now, defaultTtlSeconds: 10 });
    const captured = await service.capture({ workspaceId: 'ws-1', capture: 'display' });
    if (!captured.ok) throw new Error('capture failed');

    await expect(service.act({ workspaceId: 'ws-1', observationId: captured.value.observationId, markId: 'm1', observationHash: captured.value.observationHash, action: 'click', userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { clicked: true } });
    await expect(service.act({ workspaceId: 'ws-1', observationId: captured.value.observationId, markId: 'm1', observationHash: 'wrong', action: 'click', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.act({ workspaceId: 'ws-2', observationId: captured.value.observationId, markId: 'm1', observationHash: captured.value.observationHash, action: 'click', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(service.act({ workspaceId: 'ws-1', observationId: captured.value.observationId, markId: 'missing', observationHash: captured.value.observationHash, action: 'click', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    now = 11_001;
    await expect(service.act({ workspaceId: 'ws-1', observationId: captured.value.observationId, markId: 'm1', observationHash: captured.value.observationHash, action: 'click', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls.some((call) => isRecord(call.input) && call.input.action === 'find_element')).toBe(true);
    expect(calls.find((call) => isRecord(call.input) && call.input.action === 'click')?.input).toMatchObject({ userConfirmed: true });
  });

  it('keeps observations across request-scoped service instances while isolating MCP owners', async () => {
    const store = new SetOfMarksObservationStore();
    const capabilities: CapabilityService = {
      execute: async (tool, input): Promise<Result<unknown>> => {
        if (tool === 'accessibility' && isRecord(input) && input.action === 'observe') {
          return ok({ elements: [{ element: { name: 'Save', automation_id: 'save', enabled: true, offscreen: false, bounds: { x: 20, y: 30, width: 100, height: 40 } } }] });
        }
        if (tool === 'accessibility' && isRecord(input) && input.action === 'find_element') return ok({ element: { name: 'Save', automation_id: 'save', bounds: { x: 20, y: 30, width: 100, height: 40 } } });
        if (tool === 'accessibility' && isRecord(input) && input.action === 'click') return ok({ clicked: true });
        return ok(image);
      },
    };
    const captureRequest = new SetOfMarksService(capabilities, { store, ownerKey: 'client:session-1' });
    const actionRequest = new SetOfMarksService(capabilities, { store, ownerKey: 'client:session-1' });
    const otherSession = new SetOfMarksService(capabilities, { store, ownerKey: 'client:session-2' });
    const captured = await captureRequest.capture({ workspaceId: 'ws-1', capture: 'display' });
    if (!captured.ok) throw new Error('capture failed');

    await expect(actionRequest.act({ workspaceId: 'ws-1', observationId: captured.value.observationId, markId: 'm1', observationHash: captured.value.observationHash, action: 'click', userConfirmed: true }))
      .resolves.toMatchObject({ ok: true, value: { clicked: true } });
    await expect(otherSession.act({ workspaceId: 'ws-1', observationId: captured.value.observationId, markId: 'm1', action: 'click', userConfirmed: true }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('does not dispatch a marked UI action when cancellation wins during revalidation', async () => {
    let releaseFind!: () => void;
    let findStarted!: () => void;
    const findEntered = new Promise<void>((resolve) => { findStarted = resolve; });
    const findReleased = new Promise<void>((resolve) => { releaseFind = resolve; });
    let actions = 0;
    const capabilities: CapabilityService = {
      execute: async (tool, input): Promise<Result<unknown>> => {
        if (tool === 'accessibility' && isRecord(input) && input.action === 'observe') {
          return ok({ elements: [{ element: { name: 'Save', automation_id: 'save', enabled: true, offscreen: false, bounds: { x: 20, y: 30, width: 100, height: 40 } } }] });
        }
        if (tool === 'accessibility' && isRecord(input) && input.action === 'find_element') {
          findStarted();
          await findReleased;
          return ok({ element: { name: 'Save', automation_id: 'save' } });
        }
        if (tool === 'accessibility' && isRecord(input) && input.action === 'click') {
          actions += 1;
          return ok({ clicked: true });
        }
        return ok(image);
      },
    };
    const service = new SetOfMarksService(capabilities);
    const captured = await service.capture({ workspaceId: 'ws-1', capture: 'display' });
    if (!captured.ok) throw new Error('capture failed');
    const controller = new AbortController();

    const acting = service.act({
      workspaceId: 'ws-1',
      observationId: captured.value.observationId,
      markId: 'm1',
      observationHash: captured.value.observationHash,
      action: 'click',
      userConfirmed: true,
    }, controller.signal);
    await findEntered;
    controller.abort();
    releaseFind();

    await expect(acting).resolves.toEqual(err(appError('PROCESS_TIMEOUT', 'Marked UI action was cancelled', true)));
    expect(actions).toBe(0);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
