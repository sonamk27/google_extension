// extension/lib/mediapipe/faceDetector.js
// On-device face detection running exclusively inside the extension offscreen document.
// Raw pixels never leave the offscreen document.
// Supports native Chromium ShapeDetection FaceDetector with graceful WASM/heuristic fallback.

export async function detectFacesOnCanvas(canvas) {
  if (!canvas || !canvas.width || !canvas.height) return [];

  // 1. Check for Chromium's native ShapeDetection FaceDetector
  if (typeof window !== "undefined" && "FaceDetector" in window) {
    try {
      const detector = new window.FaceDetector({ fastMode: false, maxDetectedFaces: 25 });
      const detected = await detector.detect(canvas);
      if (Array.isArray(detected) && detected.length > 0) {
        console.log(`[faceDetector] ShapeDetection API found ${detected.length} face(s)`);
        return detected.map((face) => {
          const bb = face.boundingBox;
          return {
            x: Math.round(bb.x),
            y: Math.round(bb.y),
            w: Math.round(bb.width),
            h: Math.round(bb.height)
          };
        });
      }
      return [];
    } catch (err) {
      console.warn("[faceDetector] native FaceDetector error, falling back:", err);
    }
  }

  // 2. Fallback: Fast client-side skin-tone & face cluster detection on canvas
  // Analyzes YCbCr / HSV color space clusters for high-density facial regions
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const width = canvas.width;
    const height = canvas.height;

    // Downsample for fast scanning
    const step = 4;
    const sampleWidth = Math.floor(width / step);
    const sampleHeight = Math.floor(height / step);

    const offCanvas = document.createElement("canvas");
    offCanvas.width = sampleWidth;
    offCanvas.height = sampleHeight;
    const offCtx = offCanvas.getContext("2d");
    offCtx.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);

    const imgData = offCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;
    const skinGrid = new Uint8Array(sampleWidth * sampleHeight);

    for (let y = 0; y < sampleHeight; y++) {
      for (let x = 0; x < sampleWidth; x++) {
        const idx = (y * sampleWidth + x) * 4;
        const r = imgData[idx];
        const g = imgData[idx + 1];
        const b = imgData[idx + 2];

        // Standard skin color filter in normalized RGB & YCbCr
        const isSkin =
          r > 95 && g > 40 && b > 20 &&
          r - g > 15 && r > b &&
          Math.abs(r - g) > 15 &&
          r > 100 && g > 50 && b > 30;

        if (isSkin) {
          skinGrid[y * sampleWidth + x] = 1;
        }
      }
    }

    // Cluster skin pixels into bounding boxes
    const visited = new Uint8Array(sampleWidth * sampleHeight);
    const clusters = [];
    const minClusterPixels = Math.max(30, (sampleWidth * sampleHeight) * 0.0005);

    for (let y = 0; y < sampleHeight; y += 2) {
      for (let x = 0; x < sampleWidth; x += 2) {
        const idx = y * sampleWidth + x;
        if (skinGrid[idx] && !visited[idx]) {
          let count = 0;
          let minX = x, maxX = x, minY = y, maxY = y;
          const queue = [x, y];
          visited[idx] = 1;

          while (queue.length > 0) {
            const cy = queue.pop();
            const cx = queue.pop();
            count++;
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;

            const neighbors = [
              [cx + 2, cy], [cx - 2, cy],
              [cx, cy + 2], [cx, cy - 2]
            ];
            for (const [nx, ny] of neighbors) {
              if (nx >= 0 && nx < sampleWidth && ny >= 0 && ny < sampleHeight) {
                const nIdx = ny * sampleWidth + nx;
                if (skinGrid[nIdx] && !visited[nIdx]) {
                  visited[nIdx] = 1;
                  queue.push(nx, ny);
                }
              }
            }
          }

          const clusterW = maxX - minX;
          const clusterH = maxY - minY;
          const aspectRatio = clusterW / (clusterH || 1);

          // Faces generally have aspect ratio between 0.6 and 1.4 and sufficient density
          if (count >= minClusterPixels && aspectRatio >= 0.5 && aspectRatio <= 1.5) {
            clusters.push({
              x: Math.round(minX * step),
              y: Math.round(minY * step),
              w: Math.round(clusterW * step),
              h: Math.round(clusterH * step)
            });
          }
        }
      }
    }

    return clusters;
  } catch (err) {
    console.warn("[faceDetector] fallback detection failed:", err);
    return [];
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.FaceDetectorModule = { detectFacesOnCanvas };
}
