import type { MatchResult } from '../modules/types';
import { escapeHTML, promptSaveFile, getFormattedDate } from '../modules/helpers';

interface HeatmapPalette {
  wrapperBg: string;
  headerBg: string;
  headerBorder: string;
  textMain: string;
  textMuted: string;
  gridLine: string;
  cellPerfect: string;
  cellLowRisk: string;
  cellHighRisk: string;
  cellFailure: string;
  cellMissing: string;
}

function getHeatmapPalette(): HeatmapPalette {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  if (isDark) {
    return {
      wrapperBg: '#0f172a',
      headerBg: 'rgba(15, 23, 42, 0.96)',
      headerBorder: '#334155',
      textMain: '#f8fafc',
      textMuted: '#94a3b8',
      gridLine: 'rgba(51, 65, 85, 0.5)',
      cellPerfect: '#22c55e',
      cellLowRisk: '#f59e0b',
      cellHighRisk: '#ea580c',
      cellFailure: '#ef4444',
      cellMissing: '#334155',
    };
  }

  return {
    wrapperBg: '#ffffff',
    headerBg: 'rgba(248, 250, 252, 0.96)',
    headerBorder: '#cbd5e1',
    textMain: '#0f172a',
    textMuted: '#64748b',
    gridLine: 'rgba(226, 232, 240, 0.8)',
    cellPerfect: '#22c55e',
    cellLowRisk: '#f59e0b',
    cellHighRisk: '#ea580c',
    cellFailure: '#ef4444',
    cellMissing: '#e2e8f0',
  };
}

function getStatusWeight(status: string): number {
  switch (status) {
    case 'Failure':
    case 'Not Found':
    case 'Invalid Primer':
      return 100;
    case 'High Risk':
      return 20;
    case 'Low Risk':
      return 2;
    case 'Perfect':
      return 0;
    default:
      return 50;
  }
}

export interface HeatmapState {
  sortByFailureRate: boolean;
  hidePerfectSamples: boolean;
}

let activeRedrawFn: (() => void) | null = null;
let activeResetViewFn: (() => void) | null = null;
let activeZoomFn: ((factor: number) => void) | null = null;
let activeAbortController: AbortController | null = null;

export function redrawActiveHeatmap(): void {
  if (activeRedrawFn) activeRedrawFn();
}

export function resetActiveHeatmapView(): void {
  if (activeResetViewFn) activeResetViewFn();
}

export function zoomActiveHeatmap(factor: number): void {
  if (activeZoomFn) activeZoomFn(factor);
}

export function drawHeatmapMatrix(
  container: HTMLElement,
  allResults: MatchResult[],
  state: HeatmapState
): void {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }

  container.innerHTML = '';
  activeRedrawFn = null;
  activeResetViewFn = null;
  activeZoomFn = null;

  if (allResults.length === 0) {
    container.innerHTML = `<p style="text-align: center; color: var(--text-muted); padding: 50px;">No scan results available.</p>`;
    return;
  }

  const abortController = new AbortController();
  activeAbortController = abortController;
  const { signal } = abortController;

  // 1. Build 2D Lookup Map: Primer -> Sample -> MatchResult
  const matrix = new Map<string, Map<string, MatchResult>>();
  const primerOrderSet = new Set<string>();
  const sampleOrderSet = new Set<string>();

  const primerScores = new Map<string, number>();
  const sampleScores = new Map<string, number>();
  const sampleHasDefect = new Map<string, boolean>();

  for (const r of allResults) {
    primerOrderSet.add(r.primer_id);
    sampleOrderSet.add(r.sample_id);

    if (!matrix.has(r.primer_id)) {
      matrix.set(r.primer_id, new Map());
    }
    matrix.get(r.primer_id)!.set(r.sample_id, r);

    const weight = getStatusWeight(r.status);
    primerScores.set(r.primer_id, (primerScores.get(r.primer_id) || 0) + weight);
    sampleScores.set(r.sample_id, (sampleScores.get(r.sample_id) || 0) + weight);

    if (r.status !== 'Perfect') {
      sampleHasDefect.set(r.sample_id, true);
    } else if (!sampleHasDefect.has(r.sample_id)) {
      sampleHasDefect.set(r.sample_id, false);
    }
  }

  let primers = Array.from(primerOrderSet);
  let samples = Array.from(sampleOrderSet);

  if (state.hidePerfectSamples) {
    samples = samples.filter(s => sampleHasDefect.get(s) === true);
  }

  if (state.sortByFailureRate) {
    primers.sort((a, b) => (primerScores.get(b) || 0) - (primerScores.get(a) || 0));
    samples.sort((a, b) => (sampleScores.get(b) || 0) - (sampleScores.get(a) || 0));
  }

  if (samples.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 50px;">
        <p style="font-size: 16px; font-weight: bold; margin-bottom: 8px;">All samples are 100% Perfect!</p>
        <p style="font-size: 14px;">Uncheck <strong>"Hide Perfect Samples"</strong> to inspect the full matrix.</p>
      </div>`;
    return;
  }

  // 2. Dimensions & Dynamic View State
  const ROW_HEADER_WIDTH = 160;
  const COL_HEADER_HEIGHT = 90;
  const MAX_CELL_WIDTH = 48;

  const wrapper = document.createElement('div');
  wrapper.style.width = '100%';
  wrapper.style.height = '580px';
  wrapper.style.overflow = 'auto';
  wrapper.style.position = 'relative';
  wrapper.style.borderRadius = '6px';
  wrapper.style.border = '1px solid var(--border)';
  wrapper.style.backgroundColor = getHeatmapPalette().wrapperBg;

  const spacer = document.createElement('div');
  spacer.style.position = 'absolute';
  spacer.style.top = '0px';
  spacer.style.left = '0px';
  spacer.style.zIndex = '-1';

  const canvas = document.createElement('canvas');
  canvas.style.position = 'sticky';
  canvas.style.top = '0px';
  canvas.style.left = '0px';
  canvas.style.cursor = 'grab';

  wrapper.appendChild(spacer);
  wrapper.appendChild(canvas);
  container.appendChild(wrapper);

  // Floating Tooltip
  const tooltip = document.createElement('div');
  tooltip.style.position = 'fixed';
  tooltip.style.display = 'none';
  tooltip.style.backgroundColor = 'rgba(17, 24, 39, 0.95)';
  tooltip.style.color = '#f9fafb';
  tooltip.style.padding = '12px';
  tooltip.style.borderRadius = '8px';
  tooltip.style.fontSize = '12px';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.zIndex = '1000';
  tooltip.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.5)';
  tooltip.style.whiteSpace = 'nowrap';
  tooltip.style.lineHeight = '1.5';
  wrapper.appendChild(tooltip);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  function getFitCellWidth(): number {
    const availWidth = Math.max(200, wrapper.clientWidth - ROW_HEADER_WIDTH - 20);
    return Math.max(1.5, availWidth / samples.length);
  }

  let cellWidth = getFitCellWidth();

  function getCellHeight(): number {
    const minW = getFitCellWidth();
    // Smoothly scale row height between 15px and 22px as user zooms in
    const progress = Math.min(1, Math.max(0, (cellWidth - minW) / (24 - minW || 1)));
    return 15 + (progress * 7);
  }

  function updateSpacerSize() {
    const rowHeight = getCellHeight();
    const totalGridWidth = ROW_HEADER_WIDTH + (samples.length * cellWidth);
    const totalGridHeight = COL_HEADER_HEIGHT + (primers.length * rowHeight);
    spacer.style.width = `${totalGridWidth}px`;
    spacer.style.height = `${Math.max(580, totalGridHeight)}px`;
  }

  function resizeCanvas() {
    if (!ctx) return;
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }

  updateSpacerSize();
  resizeCanvas();

  // 3. Virtualized Render Function
  function render() {
    if (!ctx) return;

    const colors = getHeatmapPalette();
    wrapper.style.backgroundColor = colors.wrapperBg;

    const width = wrapper.clientWidth;
    const height = wrapper.clientHeight;
    const scrollX = wrapper.scrollLeft;
    const scrollY = wrapper.scrollTop;
    const rowHeight = getCellHeight();

    ctx.clearRect(0, 0, width, height);

    // Culling Range
    const colStart = Math.max(0, Math.floor((scrollX - 5) / cellWidth));
    const colEnd = Math.min(
      samples.length - 1,
      Math.ceil((scrollX + width - ROW_HEADER_WIDTH + 5) / cellWidth)
    );

    const rowStart = Math.max(0, Math.floor((scrollY - 5) / rowHeight));
    const rowEnd = Math.min(
      primers.length - 1,
      Math.ceil((scrollY + height - COL_HEADER_HEIGHT + 5) / rowHeight)
    );

    const showBorders = cellWidth >= 10 && rowHeight >= 10;
    const showRotatedLabels = cellWidth >= 12;

    // --- STEP A: Render Visible Grid Cells ---
    for (let r = rowStart; r <= rowEnd; r++) {
      const primerId = primers[r];
      const rowMap = matrix.get(primerId);
      const y = COL_HEADER_HEIGHT + (r * rowHeight) - scrollY;

      for (let c = colStart; c <= colEnd; c++) {
        const sampleId = samples[c];
        const x = ROW_HEADER_WIDTH + (c * cellWidth) - scrollX;

        const match = rowMap?.get(sampleId);
        let cellColor = colors.cellMissing;

        if (match) {
          switch (match.status) {
            case 'Perfect':
              cellColor = colors.cellPerfect;
              break;
            case 'Low Risk':
              cellColor = colors.cellLowRisk;
              break;
            case 'High Risk':
              cellColor = colors.cellHighRisk;
              break;
            case 'Failure':
            case 'Not Found':
              cellColor = colors.cellFailure;
              break;
            default:
              cellColor = colors.cellLowRisk;
              break;
          }
        }

        ctx.fillStyle = cellColor;
        ctx.fillRect(x, y, cellWidth, rowHeight);

        if (showBorders) {
          ctx.strokeStyle = colors.gridLine;
          ctx.lineWidth = 1;
          ctx.strokeRect(x, y, cellWidth, rowHeight);
        }
      }
    }

    // --- STEP B: Sticky Left Primer Headers ---
    ctx.fillStyle = colors.headerBg;
    ctx.fillRect(0, 0, ROW_HEADER_WIDTH, height);

    ctx.strokeStyle = colors.headerBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ROW_HEADER_WIDTH, 0);
    ctx.lineTo(ROW_HEADER_WIDTH, height);
    ctx.stroke();

    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let r = rowStart; r <= rowEnd; r++) {
      const primerId = primers[r];
      const y = COL_HEADER_HEIGHT + (r * rowHeight) - scrollY;
      if (y + rowHeight < COL_HEADER_HEIGHT || y > height) continue;

      ctx.fillStyle = colors.textMain;

      let label = primerId;
      if (ctx.measureText(label).width > ROW_HEADER_WIDTH - 20) {
        while (label.length > 4 && ctx.measureText(label + '…').width > ROW_HEADER_WIDTH - 20) {
          label = label.slice(0, -1);
        }
        label += '…';
      }

      ctx.fillText(label, ROW_HEADER_WIDTH - 10, y + (rowHeight / 2));
    }

    // --- STEP C: Sticky Top Sample Headers ---
    ctx.fillStyle = colors.headerBg;
    ctx.fillRect(0, 0, width, COL_HEADER_HEIGHT);

    ctx.strokeStyle = colors.headerBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, COL_HEADER_HEIGHT);
    ctx.lineTo(width, COL_HEADER_HEIGHT);
    ctx.stroke();

    if (showRotatedLabels) {
      // Detailed View: Rotated Sample Labels
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colors.textMain;

      for (let c = colStart; c <= colEnd; c++) {
        const sampleId = samples[c];
        const x = ROW_HEADER_WIDTH + (c * cellWidth) - scrollX + (cellWidth / 2);
        if (x < ROW_HEADER_WIDTH || x > width) continue;

        ctx.save();
        ctx.translate(x, COL_HEADER_HEIGHT - 8);
        ctx.rotate(-Math.PI / 4); // Rotated 45 degrees

        let sLabel = sampleId;
        if (ctx.measureText(sLabel).width > 85) {
          while (sLabel.length > 4 && ctx.measureText(sLabel + '…').width > 85) {
            sLabel = sLabel.slice(0, -1);
          }
          sLabel += '…';
        }

        ctx.fillText(sLabel, 0, 0);
        ctx.restore();
      }
    } else {
      // Dense View: Interval Numbered Ticks
      ctx.font = '10px sans-serif';
      ctx.fillStyle = colors.textMuted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelInterval = Math.max(1, Math.floor(80 / cellWidth));

      for (let c = colStart; c <= colEnd; c += labelInterval) {
        const x = ROW_HEADER_WIDTH + (c * cellWidth) - scrollX + (cellWidth / 2);
        if (x < ROW_HEADER_WIDTH || x > width) continue;

        ctx.beginPath();
        ctx.moveTo(x, COL_HEADER_HEIGHT - 6);
        ctx.lineTo(x, COL_HEADER_HEIGHT);
        ctx.strokeStyle = colors.headerBorder;
        ctx.stroke();
        ctx.fillText(`${c + 1}`, x, COL_HEADER_HEIGHT - 16);
      }
    }

    // --- STEP D: Sticky Top-Left Corner Box ---
    ctx.fillStyle = colors.headerBg;
    ctx.fillRect(0, 0, ROW_HEADER_WIDTH, COL_HEADER_HEIGHT);
    ctx.strokeStyle = colors.headerBorder;
    ctx.strokeRect(0, 0, ROW_HEADER_WIDTH, COL_HEADER_HEIGHT);

    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = colors.textMuted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Primers ➔ Samples', ROW_HEADER_WIDTH / 2, COL_HEADER_HEIGHT / 2);
  }

  // 4. View Reset & Zoom Operations
  function resetView() {
    cellWidth = getFitCellWidth();
    updateSpacerSize();
    wrapper.scrollLeft = 0;
    wrapper.scrollTop = 0;
    requestAnimationFrame(render);
  }

  function applyZoom(zoomFactor: number, focalX?: number, focalY?: number) {
    const minW = getFitCellWidth();
    const oldW = cellWidth;
    const oldH = getCellHeight();
    const newW = Math.max(minW, Math.min(MAX_CELL_WIDTH, oldW * zoomFactor));

    if (Math.abs(newW - oldW) < 0.001) return;

    const fx = focalX ?? (wrapper.clientWidth / 2);
    const fy = focalY ?? (wrapper.clientHeight / 2);

    const sampleUnderMouse = (wrapper.scrollLeft + fx - ROW_HEADER_WIDTH) / oldW;
    const primerUnderMouse = (wrapper.scrollTop + fy - COL_HEADER_HEIGHT) / oldH;

    cellWidth = newW;
    updateSpacerSize();

    const newH = getCellHeight();
    if (fx >= ROW_HEADER_WIDTH) {
      wrapper.scrollLeft = (sampleUnderMouse * newW) - fx + ROW_HEADER_WIDTH;
    }
    if (fy >= COL_HEADER_HEIGHT) {
      wrapper.scrollTop = (primerUnderMouse * newH) - fy + COL_HEADER_HEIGHT;
    }

    requestAnimationFrame(render);
  }

  activeRedrawFn = () => {
    updateSpacerSize();
    resizeCanvas();
    render();
  };
  activeResetViewFn = resetView;
  activeZoomFn = (factor) => applyZoom(factor);

  // 5. User Interaction (Zoom, Scroll, and Pan)
  wrapper.addEventListener('scroll', () => requestAnimationFrame(render));

  const resizeObserver = new ResizeObserver(() => {
    updateSpacerSize();
    resizeCanvas();
    requestAnimationFrame(render);
  });
  resizeObserver.observe(wrapper);

  // Drag-to-Pan (Click and drag)
  let isDragging = false;
  let startX = 0, startY = 0;
  let startScrollLeft = 0, startScrollTop = 0;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    canvas.style.cursor = 'grabbing';
    startX = e.pageX;
    startY = e.pageY;
    startScrollLeft = wrapper.scrollLeft;
    startScrollTop = wrapper.scrollTop;
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      canvas.style.cursor = 'grab';
    }
  }, { signal });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    tooltip.style.display = 'none';
    const dx = e.pageX - startX;
    const dy = e.pageY - startY;
    wrapper.scrollLeft = startScrollLeft - dx;
    wrapper.scrollTop = startScrollTop - dy;
  }, { signal });

  // Continuous Zoom with Ctrl / Cmd + Wheel
  wrapper.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // Allow normal native scroll if modifier isn't held
    e.preventDefault();

    const zoomFactor = e.deltaY > 0 ? 0.88 : 1.14;
    applyZoom(zoomFactor, e.offsetX, e.offsetY);
  }, { passive: false });

  // Double Click: Zoom in directly to cell, or zoom out if already close
  canvas.addEventListener('dblclick', (e) => {
    const mouseX = e.offsetX;
    const mouseY = e.offsetY;
    if (mouseX < ROW_HEADER_WIDTH || mouseY < COL_HEADER_HEIGHT) return;

    const rowHeight = getCellHeight();
    const sampleIdx = Math.floor((wrapper.scrollLeft + mouseX - ROW_HEADER_WIDTH) / cellWidth);
    const primerIdx = Math.floor((wrapper.scrollTop + mouseY - COL_HEADER_HEIGHT) / rowHeight);

    const minW = getFitCellWidth();
    // Toggle between focused micro view (26px) and overview
    const targetW = cellWidth < 20 ? 26 : minW;
    cellWidth = targetW;
    updateSpacerSize();

    const newH = getCellHeight();
    wrapper.scrollLeft = (sampleIdx * cellWidth) - (wrapper.clientWidth / 2) + ROW_HEADER_WIDTH;
    wrapper.scrollTop = (primerIdx * newH) - (wrapper.clientHeight / 2) + COL_HEADER_HEIGHT;

    tooltip.style.display = 'none';
    requestAnimationFrame(render);
  });

  // Interactive Hover Tooltip
  canvas.addEventListener('mousemove', (e) => {
    if (isDragging) {
      tooltip.style.display = 'none';
      return;
    }

    const mouseX = e.offsetX;
    const mouseY = e.offsetY;

    if (mouseX <= ROW_HEADER_WIDTH || mouseY <= COL_HEADER_HEIGHT) {
      tooltip.style.display = 'none';
      return;
    }

    const rowHeight = getCellHeight();
    const colIndex = Math.floor((mouseX - ROW_HEADER_WIDTH + wrapper.scrollLeft) / cellWidth);
    const rowIndex = Math.floor((mouseY - COL_HEADER_HEIGHT + wrapper.scrollTop) / rowHeight);

    if (colIndex >= 0 && colIndex < samples.length && rowIndex >= 0 && rowIndex < primers.length) {
      const primerId = primers[rowIndex];
      const sampleId = samples[colIndex];
      const match = matrix.get(primerId)?.get(sampleId);

      const status = match ? match.status : 'No Alignment';
      let statusColor = '#94a3b8';
      if (status === 'Perfect') statusColor = '#4ade80';
      if (status === 'Low Risk') statusColor = '#fbbf24';
      if (status === 'High Risk') statusColor = '#f97316';
      if (status === 'Failure' || status === 'Not Found') statusColor = '#f87171';

      tooltip.innerHTML = `
        <div style="margin-bottom: 6px; border-bottom: 1px solid #374151; padding-bottom: 4px;">
          <strong style="font-size: 13px;">${escapeHTML(primerId)}</strong>
          <span style="color: #94a3b8; font-size: 11px; margin-left: 6px;">➔ ${escapeHTML(sampleId)}</span>
        </div>
        <div><strong>Status:</strong> <span style="color: ${statusColor}; font-weight: bold;">${status}</span></div>
        <div><strong>Edits:</strong> ${match ? (match.mismatches === 99 ? 'N/A' : match.mismatches) : 'N/A'} (Gaps: ${match?.gaps ?? 0})</div>
        <div><strong>CIGAR:</strong> <span style="font-family: monospace;">${match?.cigar || 'N/A'}</span></div>
        ${match && match.start_pos > 0 ? `<div><strong>Coord:</strong> ${match.start_pos.toLocaleString()} - ${match.end_pos.toLocaleString()} bp</div>` : ''}
      `;

      let leftPos = e.clientX + 15;
      const topPos = e.clientY + 15;

      if (leftPos + 220 > window.innerWidth) {
        leftPos = e.clientX - 235;
      }

      tooltip.style.left = `${leftPos}px`;
      tooltip.style.top = `${topPos}px`;
      tooltip.style.display = 'block';
    } else {
      tooltip.style.display = 'none';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });

  // Initial Frame
  render();
}

// 6. Matrix TSV Export
export async function exportHeatmapMatrixTsv(
  allResults: MatchResult[],
  state: HeatmapState
): Promise<void> {
  if (allResults.length === 0) return;

  const matrix = new Map<string, Map<string, MatchResult>>();
  const primerOrderSet = new Set<string>();
  const sampleOrderSet = new Set<string>();
  const sampleHasDefect = new Map<string, boolean>();

  const primerScores = new Map<string, number>();
  const sampleScores = new Map<string, number>();

  for (const r of allResults) {
    primerOrderSet.add(r.primer_id);
    sampleOrderSet.add(r.sample_id);

    if (!matrix.has(r.primer_id)) {
      matrix.set(r.primer_id, new Map());
    }
    matrix.get(r.primer_id)!.set(r.sample_id, r);

    const weight = getStatusWeight(r.status);
    primerScores.set(r.primer_id, (primerScores.get(r.primer_id) || 0) + weight);
    sampleScores.set(r.sample_id, (sampleScores.get(r.sample_id) || 0) + weight);

    if (r.status !== 'Perfect') {
      sampleHasDefect.set(r.sample_id, true);
    } else if (!sampleHasDefect.has(r.sample_id)) {
      sampleHasDefect.set(r.sample_id, false);
    }
  }

  let primers = Array.from(primerOrderSet);
  let samples = Array.from(sampleOrderSet);

  if (state.hidePerfectSamples) {
    samples = samples.filter(s => sampleHasDefect.get(s) === true);
  }

  if (state.sortByFailureRate) {
    primers.sort((a, b) => (primerScores.get(b) || 0) - (primerScores.get(a) || 0));
    samples.sort((a, b) => (sampleScores.get(b) || 0) - (sampleScores.get(a) || 0));
  }

  const rows: string[] = [];
  rows.push(['Primer_ID', ...samples].join('\t'));

  for (const p of primers) {
    const row = [p];
    for (const s of samples) {
      const match = matrix.get(p)?.get(s);
      row.push(match ? `${match.status} (${match.mismatches} edits)` : 'Not Found');
    }
    rows.push(row.join('\t'));
  }

  const dateStr = getFormattedDate();
  const fileName = `${dateStr}_heatmap_matrix.tsv`;
  await promptSaveFile(rows.join('\n'), fileName, 'tsv', 'text/tab-separated-values');
}
