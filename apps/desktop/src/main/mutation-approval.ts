import { createRequire } from 'node:module';
import type { HostMutationApprovalRequest } from '@lnwjud/mcp-server';
import type { UiLocale } from '@lnwjud/ipc-contracts';

export interface MutationApprovalDialogOptions {
  readonly type: 'warning';
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly [string, string];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly noLink: boolean;
}

const MAX_MUTATION_APPROVAL_SUMMARY_LENGTH = 8_192;

export function isMutationApprovalRequestValid(request: HostMutationApprovalRequest): boolean {
  return request.toolName.trim().length > 0
    && request.reason.trim().length > 0
    && request.summary.trim().length > 0
    && request.summary.length <= MAX_MUTATION_APPROVAL_SUMMARY_LENGTH;
}

export function mutationApprovalDialogOptions(
  locale: UiLocale,
  request: HostMutationApprovalRequest,
  trustedHostWindowAvailable = detectTrustedHostWindowAvailable(),
): MutationApprovalDialogOptions {
  if (!isMutationApprovalRequestValid(request)) throw new Error('Invalid mutation approval request');
  if (!trustedHostWindowAvailable) throw new Error('Trusted host window is unavailable for mutation approval');

  const thai = locale === 'th';
  const workspace = request.workspaceRoot ?? (thai ? 'ไม่มี Active Project' : 'No Active Project');
  const workspaceId = request.workspaceId ?? '-';
  const detail = thai
    ? [
        `โปรเจกต์: ${workspace}`,
        `รหัสโปรเจกต์: ${workspaceId}`,
        `เครื่องมือ: ${request.toolName}`,
        `ประเภท: ${request.mutationKind}`,
        `เหตุผล: ${request.reason}`,
        '',
        'คำสั่งหรือเป้าหมายที่จะใช้จริง:',
        request.summary,
        '',
        'ตรวจสอบ path และ arguments ให้ครบก่อนอนุญาต การอนุญาตนี้ใช้ได้ครั้งเดียวเท่านั้น',
      ].join('\n')
    : [
        `Project: ${workspace}`,
        `Project ID: ${workspaceId}`,
        `Tool: ${request.toolName}`,
        `Mutation: ${request.mutationKind}`,
        `Reason: ${request.reason}`,
        '',
        'Exact command or target:',
        request.summary,
        '',
        'Verify every path and argument before approving. This approval is valid once only.',
      ].join('\n');
  return {
    type: 'warning',
    title: thai ? 'ยืนยันคำสั่งที่มีความเสี่ยง' : 'Confirm high-risk action',
    message: thai
      ? 'lnwjud กำลังจะรันคำสั่งที่อาจลบหรือแทนที่ข้อมูล'
      : 'lnwjud is about to run an action that may delete or replace data',
    detail,
    buttons: thai ? ['ยกเลิก', 'อนุญาตครั้งนี้'] : ['Cancel', 'Approve once'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export function isMutationApprovalResponse(response: number): boolean {
  return response === 1;
}

function detectTrustedHostWindowAvailable(): boolean {
  const electronVersion = (process.versions as Record<string, string | undefined>).electron;
  if (electronVersion === undefined) return true;
  try {
    const runtimeRequire = createRequire(import.meta.url);
    const electron = runtimeRequire('electron') as {
      readonly BrowserWindow?: {
        getAllWindows(): readonly { isDestroyed(): boolean }[];
      };
    };
    return electron.BrowserWindow?.getAllWindows().some((window) => !window.isDestroyed()) === true;
  } catch {
    return false;
  }
}
