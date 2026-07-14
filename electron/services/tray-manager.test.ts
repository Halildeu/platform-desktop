import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MenuItem {
  label?: string;
  type?: string;
  enabled?: boolean;
  click?: () => void;
}

const mocks = vi.hoisted(() => ({
  builtTemplate: [] as MenuItem[],
  createdWithIcon: '' as string,
  setContextMenu: vi.fn(),
  setImage: vi.fn(),
  setToolTip: vi.fn(),
  trayOn: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' },
  Menu: {
    buildFromTemplate: vi.fn((template: MenuItem[]) => {
      mocks.builtTemplate = template;
      return { __menu: true };
    }),
  },
  Tray: class {
    constructor(iconPath: string) {
      mocks.createdWithIcon = iconPath;
    }
    setToolTip = mocks.setToolTip;
    setImage = mocks.setImage;
    setContextMenu = mocks.setContextMenu;
    on = mocks.trayOn;
    destroy = mocks.destroy;
  },
}));

import { TrayManager } from './tray-manager';

function labels(): (string | undefined)[] {
  return mocks.builtTemplate.map((item) => item.label);
}

function clickItem(label: string): void {
  const item = mocks.builtTemplate.find((entry) => entry.label === label);
  if (!item?.click) {
    throw new Error(`menu item not found or has no click handler: ${label}`);
  }
  item.click();
}

function makeCallbacks(): {
  onShowWindow: ReturnType<typeof vi.fn>;
  onStopRecording: ReturnType<typeof vi.fn>;
  onPauseRecording: ReturnType<typeof vi.fn>;
  onResumeRecording: ReturnType<typeof vi.fn>;
  onQuit: ReturnType<typeof vi.fn>;
} {
  return {
    onShowWindow: vi.fn(),
    onStopRecording: vi.fn(),
    onPauseRecording: vi.fn(),
    onResumeRecording: vi.fn(),
    onQuit: vi.fn(),
  };
}

beforeEach(() => {
  mocks.builtTemplate = [];
  mocks.setContextMenu.mockClear();
  mocks.setToolTip.mockClear();
});

describe('TrayManager icon selection (#38)', () => {
  const realPlatform = process.platform;

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform });
  }

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it('uses macOS template images on darwin (idle + recording)', () => {
    setPlatform('darwin');
    const tray = new TrayManager(makeCallbacks());
    tray.create();
    expect(mocks.createdWithIcon.endsWith('trayTemplate.png')).toBe(true);

    tray.setRecordingActive(true);
    expect(mocks.setImage).toHaveBeenLastCalledWith(
      expect.stringContaining('tray-activeTemplate.png'),
    );
  });

  it('uses colored PNGs on non-darwin platforms', () => {
    setPlatform('win32');
    const tray = new TrayManager(makeCallbacks());
    tray.create();
    expect(mocks.createdWithIcon.endsWith('tray-32.png')).toBe(true);

    tray.setRecordingActive(true);
    expect(mocks.setImage).toHaveBeenLastCalledWith(expect.stringContaining('tray-active-32.png'));
  });
});

describe('TrayManager pause/resume (#37)', () => {
  it('shows no pause/resume item when idle', () => {
    const cb = makeCallbacks();
    const tray = new TrayManager(cb);
    tray.create();

    expect(labels()).toEqual(['Göster', 'Kaydı Bitir', undefined, 'Çıkış']);
    expect(labels()).not.toContain('Kaydı Duraklat');
  });

  it('offers Duraklat while recording and fires onPauseRecording', () => {
    const cb = makeCallbacks();
    const tray = new TrayManager(cb);
    tray.create();
    tray.setRecordingActive(true);

    expect(labels()).toContain('Kaydı Duraklat');
    expect(labels()).not.toContain('Kaydı Sürdür');

    clickItem('Kaydı Duraklat');
    expect(cb.onPauseRecording).toHaveBeenCalledTimes(1);
  });

  it('swaps to Sürdür once paused and fires onResumeRecording', () => {
    const cb = makeCallbacks();
    const tray = new TrayManager(cb);
    tray.create();
    tray.setRecordingActive(true);
    tray.setPaused(true);

    expect(labels()).toContain('Kaydı Sürdür');
    expect(labels()).not.toContain('Kaydı Duraklat');
    expect(mocks.setToolTip).toHaveBeenLastCalledWith('Meeting Intelligence — kayıt duraklatıldı');

    clickItem('Kaydı Sürdür');
    expect(cb.onResumeRecording).toHaveBeenCalledTimes(1);
  });

  it('clears paused state and hides pause/resume when recording stops', () => {
    const cb = makeCallbacks();
    const tray = new TrayManager(cb);
    tray.create();
    tray.setRecordingActive(true);
    tray.setPaused(true);
    tray.setRecordingActive(false);

    expect(labels()).not.toContain('Kaydı Sürdür');
    expect(labels()).not.toContain('Kaydı Duraklat');
    expect(mocks.setToolTip).toHaveBeenLastCalledWith('Meeting Intelligence');
  });
});
