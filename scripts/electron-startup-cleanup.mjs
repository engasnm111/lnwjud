import { rm } from 'node:fs/promises';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const RETRYABLE_REMOVE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);
const MAX_REMOVE_RETRIES = 10;
const REMOVE_RETRY_DELAY_MS = 100;
const MAX_REMOVE_RETRY_DELAY_MS = 500;

export async function waitForProcessExit(childProcess, timeoutMs) {
  if (childProcess.exitCode !== null) return;

  await new Promise((resolve, reject) => {
    let timeoutHandle;
    const onClose = () => {
      clearTimeout(timeoutHandle);
      resolve();
    };
    childProcess.once('close', onClose);
    timeoutHandle = setTimeout(() => {
      childProcess.removeListener('close', onClose);
      reject(new Error(`Process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

export async function removeTemporaryDirectory(directory, options = {}) {
  const remove = options.remove ?? ((target) => rm(target, { recursive: true, force: true }));
  const sleep = options.sleep ?? delay;

  for (let retry = 0; ; retry += 1) {
    try {
      await remove(directory);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (!RETRYABLE_REMOVE_CODES.has(code) || retry >= MAX_REMOVE_RETRIES) throw error;
      await sleep(Math.min(REMOVE_RETRY_DELAY_MS * 2 ** retry, MAX_REMOVE_RETRY_DELAY_MS));
    }
  }
}

function errorCode(error) {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
