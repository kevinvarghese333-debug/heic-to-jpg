import type { CropRect, ResizeSpec } from '../types';

export interface Size {
  width: number;
  height: number;
}

/** Pixel rectangle of the source to read, after applying a normalised crop. */
export function sourceRect(bitmap: Size, crop: CropRect | null): { sx: number; sy: number; sw: number; sh: number } {
  if (!crop) return { sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height };

  const sx = Math.max(0, Math.round(crop.x * bitmap.width));
  const sy = Math.max(0, Math.round(crop.y * bitmap.height));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(crop.width * bitmap.width)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(crop.height * bitmap.height)));
  return { sx, sy, sw, sh };
}

/** Size after cropping and rotating, before any resize is applied. */
export function baseSize(bitmap: Size, crop: CropRect | null, rotate: number): Size {
  const { sw, sh } = sourceRect(bitmap, crop);
  const swapped = rotate === 90 || rotate === 270;
  return { width: swapped ? sh : sw, height: swapped ? sw : sh };
}

/**
 * Applies the resize spec to a base size.
 *
 * Every mode except `exact` without `keepAspect` only ever scales down —
 * upscaling a photo adds no detail, it just makes the file bigger.
 */
export function resolveResize(base: Size, resize: ResizeSpec, extraScale = 1): Size {
  const clamp = (size: Size): Size => ({
    width: Math.max(1, Math.round(size.width * extraScale)),
    height: Math.max(1, Math.round(size.height * extraScale)),
  });

  switch (resize.mode) {
    case 'longest': {
      if (resize.longest <= 0) return clamp(base);
      const scale = Math.min(1, resize.longest / Math.max(base.width, base.height));
      return clamp({ width: base.width * scale, height: base.height * scale });
    }
    case 'percent': {
      const scale = Math.max(1, Math.min(100, resize.percent)) / 100;
      return clamp({ width: base.width * scale, height: base.height * scale });
    }
    case 'exact': {
      const targetW = Math.max(1, resize.width || base.width);
      const targetH = Math.max(1, resize.height || base.height);
      // Stretching to an exact box is an explicit request, so it is honoured
      // even when that means enlarging.
      if (!resize.keepAspect) return clamp({ width: targetW, height: targetH });
      // Fitting inside the box never enlarges — upscaling invents no detail,
      // it only makes the file bigger.
      const scale = Math.min(1, targetW / base.width, targetH / base.height);
      return clamp({ width: base.width * scale, height: base.height * scale });
    }
    case 'none':
    default:
      return clamp(base);
  }
}

/** Human summary of the current resize setting, for the UI. */
export function describeResize(resize: ResizeSpec): string {
  switch (resize.mode) {
    case 'longest':
      return resize.longest > 0 ? `Longest edge ${resize.longest}px` : 'Original size';
    case 'percent':
      return `${resize.percent}% of original`;
    case 'exact':
      return `${resize.width}×${resize.height}${resize.keepAspect ? ' (fit)' : ' (stretch)'}`;
    case 'none':
    default:
      return 'Original size';
  }
}
