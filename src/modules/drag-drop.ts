function refreshZoneUI(zoneId: string, inputId: string, textId: string) {
  const zone = document.getElementById(zoneId) as HTMLDivElement | null;
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const textLabel = document.getElementById(textId) as HTMLParagraphElement | null;

  if (!zone || !input || !textLabel) return;

  if (input.files && input.files.length > 0) {
    zone.style.borderColor = 'var(--border-success)';
    zone.style.backgroundColor = 'var(--bg-success)';
    textLabel.textContent = `${input.files[0].name}`;
    textLabel.style.color = 'var(--text-success)';
  } else {
    zone.style.borderColor = 'var(--border-hover)';
    zone.style.backgroundColor = 'var(--bg-card)';
    textLabel.textContent = "Drag & drop or click to browse";
    textLabel.style.color = 'var(--text-muted)';
  }
}

export function setupDragAndDrop(zoneId: string, inputId: string, textId: string): void {
  const zone = document.getElementById(zoneId) as HTMLDivElement | null;
  const input = document.getElementById(inputId) as HTMLInputElement | null;

  if (!zone || !input) return;

  // Visual highlights when hovering over the invisible input
  input.addEventListener('dragenter', () => {
    zone.style.borderColor = 'var(--border-active)';
    zone.style.backgroundColor = 'var(--bg-active)';
  });

  input.addEventListener('dragleave', () => refreshZoneUI(zoneId, inputId, textId));
  input.addEventListener('change', () => refreshZoneUI(zoneId, inputId, textId));
  input.addEventListener('drop', () => {
    setTimeout(() => refreshZoneUI(zoneId, inputId, textId), 50);
  });
}

export function setupGlobalDropGuards(): void {
  window.addEventListener("dragover", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'file') return;
    e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'file') return;
    e.preventDefault();
  });
}