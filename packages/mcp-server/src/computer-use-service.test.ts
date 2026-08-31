import { describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { CapabilityService, CapabilityToolName } from '@lnwjud/capabilities';
import { ComputerUseService } from './computer-use-service.js';
import { SetOfMarksService } from './set-of-marks-service.js';

const image = {
  format: 'png',
  mime_type: 'image/png',
  data_base64: 'cG5n',
  width: 800,
  height: 600,
  origin_x: 0,
  origin_y: 0,
};

describe('ComputerUseService', () => {
  it('returns an annotated semantic snapshot when Accessibility is available', async () => {
    const calls: Array<{ tool: CapabilityToolName; input: unknown }> = [];
    const capabilities = capabilityService(calls, async (tool, input) => {
      if (tool === 'accessibility') return ok({ elements: [{ element: { name: 'Save', automation_id: 'save', enabled: true, offscreen: false, bounds: { x: 20, y: 30, width: 100, height: 40 } } }] });
      if (tool === 'vision' && isRecord(input) && input.action === 'annotate') return ok({ ...image, annotated: true });
      return ok(image);
    });
    const marks = new SetOfMarksService(capabilities);
    const service = new ComputerUseService(capabilities, marks);

    const result = await service.execute({ workspaceId: 'ws-1', action: 'snapshot', capture: 'display' });

    expect(result).toMatchObject({ ok: true, value: {
      mode: 'annotated',
      observationId: expect.any(String),
      marks: [{ markId: 'm1', label: 'Save' }],
      image: { format: 'png', annotated: true },
    } });
    expect(calls.map((call) => call.tool)).toEqual(['accessibility', 'vision', 'vision']);
  });

  it('falls back to a raw screenshot when semantic observation fails', async () => {
    const calls: Array<{ tool: CapabilityToolName; input: unknown }> = [];
    const capabilities = capabilityService(calls, async (tool) => {
      if (tool === 'accessibility') return err(appError('INTERNAL_ERROR', 'UI Automation unavailable', true));
      return ok(image);
    });
    const service = new ComputerUseService(capabilities, new SetOfMarksService(capabilities));

    const result = await service.execute({ workspaceId: 'ws-1', action: 'snapshot', capture: 'display' });

    expect(result).toMatchObject({ ok: true, value: {
      mode: 'visual_fallback',
      semantic_available: false,
      semantic_error: { code: 'INTERNAL_ERROR' },
      image: { format: 'png' },
    } });
    expect(calls.map((call) => call.tool)).toEqual(['accessibility', 'vision']);
  });

  it('routes semantic and coordinate clicks through the safest matching primitive', async () => {
    const calls: Array<{ tool: CapabilityToolName; input: unknown }> = [];
    const capabilities = capabilityService(calls, async () => ok({ done: true }));
    const service = new ComputerUseService(capabilities, new SetOfMarksService(capabilities));

    await expect(service.execute({
      workspaceId: 'ws-1', action: 'click', target: { name: 'Save' }, app: { title: 'Editor' }, userConfirmed: true,
    })).resolves.toMatchObject({ ok: true });
    await expect(service.execute({
      workspaceId: 'ws-1', action: 'click', target: { x: 120, y: 240 }, userConfirmed: true,
    })).resolves.toMatchObject({ ok: true });

    expect(calls[0]).toMatchObject({ tool: 'accessibility', input: { action: 'click', parameters: { title: 'Editor', name: 'Save' }, userConfirmed: true } });
    expect(calls[1]).toMatchObject({ tool: 'input_event', input: { operation: 'click', parameters: { x: 120, y: 240 }, userConfirmed: true } });
  });

  it('uses the same Set-of-Marks observation for a revalidated numbered click', async () => {
    const calls: Array<{ tool: CapabilityToolName; input: unknown }> = [];
    const capabilities = capabilityService(calls, async (tool, input) => {
      if (tool === 'accessibility' && isRecord(input) && input.action === 'observe') {
        return ok({ elements: [{ element: { name: 'Save', automation_id: 'save', enabled: true, offscreen: false, bounds: { x: 20, y: 30, width: 100, height: 40 } } }] });
      }
      if (tool === 'accessibility' && isRecord(input) && input.action === 'find_element') return ok({ element: { name: 'Save', automation_id: 'save' } });
      if (tool === 'accessibility' && isRecord(input) && input.action === 'click') return ok({ clicked: true });
      if (tool === 'vision' && isRecord(input) && input.action === 'annotate') return ok({ ...image, annotated: true });
      return ok(image);
    });
    const marks = new SetOfMarksService(capabilities);
    const service = new ComputerUseService(capabilities, marks);
    const snapshot = await service.execute({ workspaceId: 'ws-1', action: 'snapshot' });
    if (!snapshot.ok || !isRecord(snapshot.value)) throw new Error('snapshot failed');

    const clicked = await service.execute({
      workspaceId: 'ws-1',
      action: 'click',
      target: {
        observationId: snapshot.value.observationId,
        observationHash: snapshot.value.observationHash,
        markId: 'm1',
      },
      userConfirmed: true,
    });

    expect(clicked).toMatchObject({ ok: true, value: { clicked: true } });
    const finalClick = calls.find((call) => call.tool === 'accessibility' && isRecord(call.input) && call.input.action === 'click');
    expect(finalClick?.input).toMatchObject({ userConfirmed: true });
  });

  it('focuses a semantic field before typing and forwards confirmation to raw input', async () => {
    const calls: Array<{ tool: CapabilityToolName; input: unknown }> = [];
    const capabilities = capabilityService(calls, async () => ok({ done: true }));
    const service = new ComputerUseService(capabilities, new SetOfMarksService(capabilities));

    const result = await service.execute({
      workspaceId: 'ws-1',
      action: 'type_text',
      target: { automation_id: 'username' },
      app: { title: 'Login' },
      text: 'alice',
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true });
    expect(calls).toMatchObject([
      { tool: 'accessibility', input: { action: 'focus', parameters: { title: 'Login', automation_id: 'username' }, userConfirmed: true } },
      { tool: 'input_event', input: { operation: 'type_text', parameters: { text: 'alice' }, userConfirmed: true } },
    ]);
  });
});

function capabilityService(
  calls: Array<{ tool: CapabilityToolName; input: unknown }>,
  handler: (tool: CapabilityToolName, input: unknown) => Promise<Result<unknown>>,
): CapabilityService {
  return {
    execute: async (tool, input): Promise<Result<unknown>> => {
      calls.push({ tool, input });
      return handler(tool, input);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
