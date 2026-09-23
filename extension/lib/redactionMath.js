// extension/lib/redactionMath.js
// Pure mathematical functions for coordinate transformation and bounding box scaling.
// Handles device pixel ratio (DPR), viewport scaling, and safety margins.

export function computeScaleFactors(naturalWidth, naturalHeight, cssViewport) {
  const scaleX = cssViewport?.w && cssViewport.w > 0 ? naturalWidth / cssViewport.w : 1;
  const scaleY = cssViewport?.h && cssViewport.h > 0 ? naturalHeight / cssViewport.h : 1;
  return { scaleX, scaleY };
}

export function transformBoxToCanvas(box, scaleX, scaleY, margin = 3) {
  if (!box || typeof box.x !== "number" || typeof box.y !== "number") {
    return null;
  }
  const w = typeof box.w === "number" ? box.w : (box.width || 0);
  const h = typeof box.h === "number" ? box.h : (box.height || 0);

  return {
    x: Math.max(0, Math.round(box.x * scaleX - margin)),
    y: Math.max(0, Math.round(box.y * scaleY - margin)),
    w: Math.round(w * scaleX + margin * 2),
    h: Math.round(h * scaleY + margin * 2)
  };
}

export function calculateRedactionRects(naturalWidth, naturalHeight, cssViewport, boxes = [], margin = 3) {
  const { scaleX, scaleY } = computeScaleFactors(naturalWidth, naturalHeight, cssViewport);
  return (boxes || [])
    .map((b) => transformBoxToCanvas(b, scaleX, scaleY, margin))
    .filter(Boolean);
}

if (typeof globalThis !== "undefined") {
  globalThis.RedactionMath = {
    computeScaleFactors,
    transformBoxToCanvas,
    calculateRedactionRects
  };
}
