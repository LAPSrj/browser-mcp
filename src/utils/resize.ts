import { PNG } from "pngjs";

const MAX_PREVIEW_WIDTH = 800;
const MAX_PREVIEW_HEIGHT = 800;

/**
 * Downscale a PNG buffer to fit within 800x800.
 * Returns the original buffer unchanged if it already fits.
 */
export function createPreviewBuffer(pngBuffer: Buffer): Buffer {
  const img = PNG.sync.read(pngBuffer);

  if (img.width <= MAX_PREVIEW_WIDTH && img.height <= MAX_PREVIEW_HEIGHT) {
    return pngBuffer;
  }

  const scale = Math.min(
    MAX_PREVIEW_WIDTH / img.width,
    MAX_PREVIEW_HEIGHT / img.height,
  );
  const dstW = Math.round(img.width * scale);
  const dstH = Math.round(img.height * scale);

  const dst = new PNG({ width: dstW, height: dstH });

  for (let y = 0; y < dstH; y++) {
    const srcY = Math.min(Math.floor(y / scale), img.height - 1);
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(Math.floor(x / scale), img.width - 1);
      const srcIdx = (srcY * img.width + srcX) << 2;
      const dstIdx = (y * dstW + x) << 2;
      dst.data[dstIdx] = img.data[srcIdx];
      dst.data[dstIdx + 1] = img.data[srcIdx + 1];
      dst.data[dstIdx + 2] = img.data[srcIdx + 2];
      dst.data[dstIdx + 3] = img.data[srcIdx + 3];
    }
  }

  return PNG.sync.write(dst);
}
