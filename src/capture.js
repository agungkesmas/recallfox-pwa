// src/capture.js — Camera / Gallery / Paste handlers

/**
 * Pick image from camera or gallery.
 * @param {'camera'|'gallery'} source
 * @returns {Promise<{dataUrl: string, width: number, height: number}|null>}
 */
export function pickImage(source) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (source === 'camera') {
      input.capture = 'environment';
    }
    input.multiple = false;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const img = new Image();
        img.onload = () => {
          resolve({ dataUrl, width: img.naturalWidth, height: img.naturalHeight });
        };
        img.onerror = () => resolve({ dataUrl, width: 0, height: 0 });
        img.src = dataUrl;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

/**
 * Paste image from clipboard.
 * @returns {Promise<{dataUrl: string, width: number, height: number}|null>}
 */
export async function pasteFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('read_failed'));
            reader.readAsDataURL(blob);
          });
          const img = new Image();
          return new Promise((resolve2) => {
            img.onload = () => resolve2({ dataUrl, width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => resolve2({ dataUrl, width: 0, height: 0 });
            img.src = dataUrl;
          });
        }
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}
