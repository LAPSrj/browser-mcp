import { PNG } from "pngjs";

export interface IgnoreElement {
  selector: string;
  mode: "invisible" | "position-only";
}

export interface MaskRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  mode: "invisible" | "position-only";
  reason?: string;
}

export interface MaskOptions {
  ignoreImages?: boolean;
  ignoreBackgrounds?: boolean;
  ignoreAllImages?: boolean;
  ignoreText?: boolean;
  ignoreElements?: IgnoreElement[];
}

export async function collectMaskRegions(
  page: any,
  options: MaskOptions,
): Promise<MaskRegion[]> {
  const {
    ignoreImages,
    ignoreBackgrounds,
    ignoreAllImages,
    ignoreText,
    ignoreElements,
  } = options;

  const allIgnores: IgnoreElement[] = [...(ignoreElements ?? [])];
  if (ignoreImages || ignoreAllImages) {
    allIgnores.push({ selector: "img", mode: "position-only" });
  }

  const needBackgrounds = ignoreBackgrounds || ignoreAllImages;

  if (allIgnores.length === 0 && !needBackgrounds && !ignoreText) return [];

  const selectors = allIgnores.map((e) => e.selector);
  const result: {
    bySelector: Array<Array<{ x: number; y: number; width: number; height: number }>>;
    backgrounds: Array<{ x: number; y: number; width: number; height: number }>;
    texts: Array<{ x: number; y: number; width: number; height: number }>;
  } = await page.evaluate(
    (args: { sels: string[]; findBackgrounds: boolean; findText: boolean }) => {
      const bySelector = args.sels.map((sel: string) => {
        const results: Array<{ x: number; y: number; width: number; height: number }> = [];
        document.querySelectorAll(sel).forEach((el: Element) => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            results.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
          }
        });
        return results;
      });

      const backgrounds: Array<{ x: number; y: number; width: number; height: number }> = [];
      if (args.findBackgrounds) {
        document.querySelectorAll("*").forEach((el: Element) => {
          const style = getComputedStyle(el);
          if (style.backgroundImage && style.backgroundImage !== "none") {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              backgrounds.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
            }
          }
        });
      }

      // Walk text nodes, build a Range over each, and collect the per-line
      // client rects. This gives us tight text-line bboxes rather than the
      // loose bbox of the parent element (which would also mask padding/
      // adjacent siblings). Empty rects and hidden-text nodes are skipped.
      const texts: Array<{ x: number; y: number; width: number; height: number }> = [];
      if (args.findText) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const text = (node.textContent ?? "").trim();
          if (!text) continue;
          const parent = (node as Text).parentElement;
          if (!parent) continue;
          const style = getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden") continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = range.getClientRects();
          for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            if (r.width > 0 && r.height > 0) {
              texts.push({ x: r.x, y: r.y, width: r.width, height: r.height });
            }
          }
        }
      }

      return { bySelector, backgrounds, texts };
    },
    { sels: selectors, findBackgrounds: !!needBackgrounds, findText: !!ignoreText },
  );

  const regions: MaskRegion[] = [];
  for (let i = 0; i < allIgnores.length; i++) {
    for (const box of result.bySelector[i]) {
      regions.push({ ...box, mode: allIgnores[i].mode });
    }
  }
  for (const box of result.backgrounds) {
    regions.push({ ...box, mode: "position-only" });
  }
  // Text masks use position-only so the presence and location of a text run
  // is still verified — only glyph-interior pixels are hidden. A layout
  // regression that moves or resizes the text will still surface.
  for (const box of result.texts) {
    regions.push({ ...box, mode: "position-only", reason: "ignoreText" });
  }
  return regions;
}

export function applyMask(
  png: PNG,
  regions: MaskRegion[],
  offsetX = 0,
  offsetY = 0,
): void {
  for (const region of regions) {
    const rx = region.x - offsetX;
    const ry = region.y - offsetY;
    const x0 = Math.max(0, Math.floor(rx));
    const y0 = Math.max(0, Math.floor(ry));
    const x1 = Math.min(png.width, Math.ceil(rx + region.width));
    const y1 = Math.min(png.height, Math.ceil(ry + region.height));

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * png.width + x) << 2;
        if (region.mode === "invisible") {
          png.data[idx] = 0;
          png.data[idx + 1] = 0;
          png.data[idx + 2] = 0;
          png.data[idx + 3] = 0;
        } else {
          png.data[idx] = 128;
          png.data[idx + 1] = 128;
          png.data[idx + 2] = 128;
          png.data[idx + 3] = 255;
        }
      }
    }
  }
}
