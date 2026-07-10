/**
 * Window state persistence — electron-store (token-store.ts ile aynı desen).
 * Saf clamp/visibility mantığı window-bounds.ts'te (Electron'suz, unit-testable).
 */

import Store from 'electron-store';

import type { WindowBounds } from './window-bounds';

interface PersistShape {
  bounds?: WindowBounds;
}

export class WindowStateStore {
  private readonly store: Store<PersistShape>;

  constructor() {
    this.store = new Store<PersistShape>({ name: 'window-state', clearInvalidConfig: true });
  }

  load(): WindowBounds | undefined {
    return this.store.get('bounds');
  }

  save(bounds: WindowBounds): void {
    this.store.set('bounds', bounds);
  }
}
