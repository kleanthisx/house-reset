// Reset — photo resize worker. Decode + scale off the main thread so a 12MP
// capture doesn't jank the UI at the exact moment the user is waiting.
// Classic worker (broad support). Message in: {id, file}. Out: {id, ok, full,
// thumb, width, height} or {id, ok:false, error}.

self.onmessage = async (e) => {
  const { id, file } = e.data;
  try {
    const bitmap = await createImageBitmap(file); // handles EXIF orientation in modern browsers
    const srcW = bitmap.width, srcH = bitmap.height;

    const full = await resize(bitmap, 1600, 0.8);
    const thumb = await resize(bitmap, 320, 0.7);
    bitmap.close && bitmap.close();

    // Blobs are structured-cloned (cheap, by-reference) — NOT transferable, so no transfer list.
    self.postMessage({ id, ok: true, full, thumb, width: full.width, height: full.height, srcW, srcH });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};

// Scale so the longest edge <= max (never upscale), export JPEG at quality.
async function resize(bitmap, maxEdge, quality) {
  const { width, height } = bitmap;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { blob, width: w, height: h };
}
