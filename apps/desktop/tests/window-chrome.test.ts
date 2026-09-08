import { describe, expect, it } from 'vitest';
import { windowChromeOptions } from '../src/main/window-chrome.js';

describe('native window chrome', () => {
  it('keeps macOS traffic lights while avoiding Windows overlay options', (): void => {
    expect(windowChromeOptions('darwin')).toEqual({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 } });
  });

  it('uses the Windows overlay only on Windows', (): void => {
    expect(windowChromeOptions('win32')).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { height: 38 } });
    expect(windowChromeOptions('linux')).toEqual({});
  });
});
