import { PNG } from "pngjs";

/**
 * Copy a rectangular region out of `src` into a new PNG. Negative or
 * out-of-bounds coords are tolerated — pixels outside `src` are left as zero
 * (transparent black). `w`/`h` define the destination size; the destination
 * always matches that size regardless of how much of `src` actually
 * overlapped the requested region.
 */
export function cropPng(src: PNG, x: number, y: number, w: number, h: number): PNG {
  const dst = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const srcY = y + row;
    if (srcY < 0) continue;
    if (srcY >= src.height) break;
    const srcX = Math.max(0, x);
    const dstXOffset = srcX - x;
    if (dstXOffset >= w) continue;
    const copyWidth = Math.min(w - dstXOffset, src.width - srcX);
    if (copyWidth <= 0) continue;
    const srcOff = (srcY * src.width + srcX) << 2;
    const dstOff = (row * w + dstXOffset) << 2;
    src.data.copy(dst.data, dstOff, srcOff, srcOff + (copyWidth << 2));
  }
  return dst;
}
