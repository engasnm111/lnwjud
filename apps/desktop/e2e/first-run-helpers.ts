import { expect, type Page } from '@playwright/test';

const HOME_HEADING = /^(ศูนย์ควบคุม Agent|Agent Control Center)$/;
const HOME_NAV = /^(หน้าหลัก|Home)$/;
const SET_UP_LATER = /^(ไว้ทีหลัง|Set up later)$/;
const RUN_DOCTOR = /^(รัน Doctor|Run doctor)$/;
const STARTUP_DOCTOR_STORAGE_KEY = 'lnwjud.startup-doctor.passed-version.v1';
const GUIDED_TUNNEL_STORAGE_KEY = 'lnwjud.guided-tunnel-setup.v1';

/**
 * Settles the real first-run state machine instead of assuming a render order.
 * Startup Doctor may render before the onboarding effect, especially in packaged
 * builds, so this synchronizes on the persisted app-version marker first and
 * only then dismisses whichever onboarding surface the renderer actually chose.
 */
export async function settleFirstRunAndOpenHome(page: Page): Promise<void> {
  const tipDialog = page.getByRole('dialog', { name: /ตั้งค่า ChatGPT ให้ใช้ lnwjud|Set up ChatGPT to use lnwjud/ });
  const guidedSetup = page.getByTestId('guided-tunnel-setup');
  const homeHeading = page.getByRole('heading', { name: HOME_HEADING });
  const doctorHeading = page.getByRole('heading', { name: 'Doctor', exact: true });

  await expect.poll(async () => (
    await tipDialog.isVisible()
    || await guidedSetup.isVisible()
    || await homeHeading.isVisible()
    || await doctorHeading.isVisible()
  ), { timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);

  if (await doctorHeading.isVisible()) {
    try {
      await expect.poll(async () => (await startupCoreFailures(page)).length, {
        timeout: 30_000,
        intervals: [100, 250, 500, 1_000],
      }).toBe(0);
    } catch (cause: unknown) {
      const failures = await startupCoreFailures(page);
      throw new Error(`Startup prerequisites failed before onboarding: ${JSON.stringify(failures)}`, { cause });
    }

    // Exercise the real renderer recovery path so React state and the durable
    // startup marker advance together. Writing localStorage directly here would
    // merely hide the race that packaged E2E is supposed to catch.
    await page.getByRole('button', { name: RUN_DOCTOR }).click({ timeout: 30_000 });
  }

  await expect.poll(async () => page.evaluate(async (key) => {
    const dashboard = await window.lnwjud.getDashboard();
    return window.localStorage.getItem(key) === dashboard.appVersion;
  }, STARTUP_DOCTOR_STORAGE_KEY), {
    timeout: 30_000,
    intervals: [100, 250, 500],
  }).toBe(true);

  // Once Startup Doctor is accepted, wait for the onboarding effect itself to
  // make a decision. A fresh, unconfigured install must actually surface Tips;
  // configured/dismissed installs can legitimately proceed without a dialog.
  await expect.poll(async () => {
    if (await tipDialog.isVisible() || await guidedSetup.isVisible()) return true;
    return page.evaluate(async (guidedKey) => {
      const dashboard = await window.lnwjud.getDashboard();
      const state = window.localStorage.getItem(guidedKey);
      const configured = dashboard.tunnel.profileExists
        || dashboard.tunnel.hasApiKey
        || dashboard.tunnel.auth?.mode === 'oauth';
      return configured || state === 'dismissed';
    }, GUIDED_TUNNEL_STORAGE_KEY);
  }, { timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);

  if (await tipDialog.isVisible()) {
    await tipDialog.getByRole('button', { name: SET_UP_LATER }).click({ timeout: 30_000 });
    await expect(tipDialog).toBeHidden();
  }

  if (await guidedSetup.isVisible()) {
    await guidedSetup.getByRole('button', { name: SET_UP_LATER }).click({ timeout: 30_000 });
    await expect(guidedSetup).toBeHidden();
  }

  if (!await homeHeading.isVisible()) {
    await page.getByRole('button', { name: HOME_NAV }).click({ timeout: 30_000 });
  }
  await expect(homeHeading).toBeVisible({ timeout: 30_000 });
  await expect(tipDialog).toBeHidden();
  await expect(guidedSetup).toBeHidden();
}

async function startupCoreFailures(page: Page): Promise<readonly {
  readonly id: string;
  readonly status: string;
  readonly message: string;
  readonly detail?: string;
  readonly durationMs: number;
}[]> {
  return page.evaluate(async () => {
    const coreIds = new Set(['os', 'database', 'executable_ripgrep', 'mcp-port']);
    const report = await window.lnwjud.runDoctor();
    return report.checks
      .filter((check) => coreIds.has(check.id) && (check.status === 'fail' || check.status === 'unknown'))
      .map(({ id, status, message, detail, durationMs }) => ({
        id,
        status,
        message,
        ...(detail === undefined ? {} : { detail }),
        durationMs,
      }));
  });
}
