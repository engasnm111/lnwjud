// Direct DesktopRuntime unit tests do not boot Electron's composition root.
// Give those tests a deterministic explicit key without weakening production
// startup, which must inject Electron safeStorage output instead.
if (process.env.LNWJUD_CHECKPOINT_KEY_BASE64 === undefined) {
  process.env.LNWJUD_CHECKPOINT_KEY_BASE64 = Buffer.alloc(32, 0x4c).toString('base64');
}
