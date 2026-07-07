/**
 * Window bounds saf yardımcıları — Electron'a BAĞIMSIZ (unit-testable).
 * Persistence (electron-store) ayrı dosyada (window-state-store.ts).
 */

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayBounds {
  bounds: WindowBounds;
}

const MIN_WIDTH = 1024;
const MIN_HEIGHT = 700;

/**
 * Kaydedilmiş pencere boyutu artık hiçbir ekranda görünür değilse (ekran
 * söküldü/çözünürlük değişti), varsayılana dön — ekran dışında sıkışmış bir
 * pencere kullanıcı için kurtarılamaz olur.
 */
export function isBoundsVisibleOnAnyDisplay(
  saved: WindowBounds,
  displays: readonly DisplayBounds[],
): boolean {
  const probeSize = 50; // klasik electron-window-state yaklaşımı: köşe örtüşme kontrolü
  return displays.some((d) => {
    const db = d.bounds;
    return (
      saved.x + probeSize <= db.x + db.width &&
      saved.x + saved.width - probeSize >= db.x &&
      saved.y + probeSize <= db.y + db.height &&
      saved.y + saved.height - probeSize >= db.y
    );
  });
}

export function resolveWindowBounds(
  saved: WindowBounds | undefined,
  displays: readonly DisplayBounds[],
  fallback: WindowBounds,
): WindowBounds {
  if (!saved) {
    return fallback;
  }
  const clamped: WindowBounds = {
    x: saved.x,
    y: saved.y,
    width: Math.max(MIN_WIDTH, saved.width),
    height: Math.max(MIN_HEIGHT, saved.height),
  };
  return isBoundsVisibleOnAnyDisplay(clamped, displays) ? clamped : fallback;
}
