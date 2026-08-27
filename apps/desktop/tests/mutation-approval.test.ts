import { describe, expect, it } from 'vitest';
import type { HostMutationApprovalRequest } from '@lnwjud/mcp-server';
import { isMutationApprovalRequestValid, isMutationApprovalResponse, mutationApprovalDialogOptions } from '../src/main/mutation-approval.js';

const request: HostMutationApprovalRequest = {
  toolName: 'shell',
  mutationKind: 'opaque_mutation',
  reason: 'shell run can execute effects that cannot be proven from argv',
  summary: 'tool = shell\ncwd = E:\\project-a\\tools\nexecutable = node.exe\narguments = ["cleanup.js"]',
  workspaceId: 'workspace-a',
  workspaceRoot: 'E:\\project-a',
};

describe('desktop exact-action mutation approval', () => {
  it('makes cancel the safe default and shows the exact scoped command in Thai', () => {
    const options = mutationApprovalDialogOptions('th', request);
    expect(options).toMatchObject({
      type: 'warning', defaultId: 0, cancelId: 0, noLink: true,
      buttons: ['ยกเลิก', 'อนุญาตครั้งนี้'],
    });
    expect(options.message).toContain('ลบหรือแทนที่ข้อมูล');
    expect(options.detail).toContain('E:\\project-a');
    expect(options.detail).toContain('cwd = E:\\project-a\\tools');
    expect(options.detail).toContain('arguments = ["cleanup.js"]');
    expect(options.detail).toContain(request.reason);
  });

  it('approves only the explicit second button and provides an English variant', () => {
    const options = mutationApprovalDialogOptions('en', request);
    expect(options.buttons).toEqual(['Cancel', 'Approve once']);
    expect(options.message).toContain('delete or replace data');
    expect(isMutationApprovalResponse(0)).toBe(false);
    expect(isMutationApprovalResponse(1)).toBe(true);
    expect(isMutationApprovalResponse(2)).toBe(false);
  });

  it('fails closed for empty or oversized exact-action summaries', () => {
    expect(isMutationApprovalRequestValid(request)).toBe(true);
    expect(isMutationApprovalRequestValid({ ...request, summary: '   ' })).toBe(false);
    expect(isMutationApprovalRequestValid({ ...request, summary: 'x'.repeat(8_193) })).toBe(false);
    expect(isMutationApprovalRequestValid({ ...request, toolName: '' })).toBe(false);
    expect(isMutationApprovalRequestValid({ ...request, reason: '' })).toBe(false);
  });

  it('refuses to create an approval dialog without a trusted host window or for an invalid request', () => {
    expect(() => mutationApprovalDialogOptions('en', request, false)).toThrow(/trusted host window/i);
    expect(() => mutationApprovalDialogOptions('en', { ...request, summary: '   ' }, true)).toThrow(/invalid/i);
  });
});
