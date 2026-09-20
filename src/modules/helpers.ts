import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

// Get Current Date in YYYY-MM-DD format
export function getFormattedDate(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Sanitizes user/sequence input to prevent XSS
export function escapeHTML(str: string): string {
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

// Reads an uploaded File instance as text string
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target?.result as string);
    reader.onerror = e => reject(e);
    reader.readAsText(file);
  });
}

// Universal save file handler:
// 1. Native Tauri Dialog (Desktop)
// 2. File System Access API (Chromium / Edge)
// 3. Blob anchor download fallback (Firefox / Safari)
export async function promptSaveFile(
  content: string,
  defaultFileName: string,
  fileExtension: string,
  mimeType: string
): Promise<void> {
  // 1. Desktop App (Tauri Native Dialog)
  if ('__TAURI_INTERNALS__' in window) {
    try {
      const filePath = await save({
        defaultPath: defaultFileName,
        filters: [{ name: 'Export Data', extensions: [fileExtension] }]
      });

      // If the user didn't cancel the dialog, save the file
      if (filePath) {
        await writeTextFile(filePath, content);
      }
    } catch (err) {
      console.error("Tauri save failed:", err);
      alert("Failed to save file. Check Tauri permissions.");
    }
    return; // Always return here so Tauri doesn't fall back to the Web download
  }

  // 2. Web Browser (Modern Chromium/Edge File Picker)
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as unknown as {
        showSaveFilePicker: (options: unknown) => Promise<FileSystemFileHandle>;
      }).showSaveFilePicker({
        suggestedName: defaultFileName,
        types: [{
          description: `${fileExtension.toUpperCase()} File`,
          accept: { [mimeType]: [`.${fileExtension}`] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return; // Return here so Chromium doesn't fall back
    } catch (err: unknown) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        console.error("File Picker Error:", err);
      }
      return; // User cancelled
    }
  }

  // 3. Web Browser Fallback (Firefox, Safari)
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", defaultFileName);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}