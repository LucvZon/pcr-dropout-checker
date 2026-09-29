import type { MatchResult } from '../modules/types';
import { escapeHTML } from '../modules/helpers';

interface CanvasPalette {
  wrapperBg: string;
  stickyBg: string;
  stickyBorder: string;
  rulerText: string;
  rulerMajorTick: string;
  rulerMinorTick: string;
  refBg: string;
  refBorder: string;
  refText: string;
  primerIdText: string;
  boxMatchBg: string;
  boxMatchText: string;
  boxMismatchBg: string;
  boxMismatchText: string;
}

function getCanvasColors(): CanvasPalette {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  if (isDark) {
    return {
      wrapperBg: '#0f172a',
      stickyBg: 'rgba(15, 23, 42, 0.95)',
      stickyBorder: '#334155',
      rulerText: '#94a3b8',
      rulerMajorTick: '#94a3b8',
      rulerMinorTick: '#334155',
      refBg: '#1e293b',
      refBorder: '#3b82f6',
      refText: '#60a5fa',
      primerIdText: '#f1f5f9',
      boxMatchBg: '#1e293b',
      boxMatchText: '#cbd5e1',
      boxMismatchBg: '#7f1d1d',
      boxMismatchText: '#fca5a5',
    };
  }

  return {
    wrapperBg: '#f8fafc',
    stickyBg: 'rgba(248, 250, 252, 0.95)',
    stickyBorder: '#cbd5e1',
    rulerText: '#475569',
    rulerMajorTick: '#475569',
    rulerMinorTick: '#cbd5e1',
    refBg: '#dbeafe',
    refBorder: '#bfdbfe',
    refText: '#1e40af',
    primerIdText: '#1e293b',
    boxMatchBg: '#e2e8f0',
    boxMatchText: '#334155',
    boxMismatchBg: '#fee2e2',
    boxMismatchText: '#dc2626',
  };
}

export interface AlignmentToken {
  text: string;
  isError: boolean;
  consumesRef: boolean;
}

export function parseAlignmentTokens(alignment: string): AlignmentToken[] {
  const tokens: AlignmentToken[] = [];
  let i = 0;
  while (i < alignment.length) {
    if (alignment[i] === '[') {
      const end = alignment.indexOf(']', i);
      if (end !== -1) {
        tokens.push({
          text: alignment.substring(i + 1, end),
          isError: true,
          consumesRef: true,
        });
        i = end + 1;
        continue;
      }
    } else if (alignment[i] === '{') {
      const end = alignment.indexOf('}', i);
      if (end !== -1) {
        tokens.push({
          text: alignment.substring(i + 1, end),
          isError: true,
          consumesRef: false,
        });
        i = end + 1;
        continue;
      }
    }
    tokens.push({
      text: alignment[i],
      isError: false,
      consumesRef: true,
    });
    i++;
  }
  return tokens;
}

// Track active map redraw callback to trigger on theme switch
let activeRedrawFn: (() => void) | null = null;

export function redrawActiveGenomeMap(): void {
  if (activeRedrawFn) {
    activeRedrawFn();
  }
}

export function drawGenomeMap(
  mapContainer: HTMLElement,
  sampleId: string,
  allResults: MatchResult[],
  sampleSequences: Map<string, string>
): void {
  mapContainer.innerHTML = ""; // Clear old map
  activeRedrawFn = null;

  const sampleResults = allResults.filter(r => r.sample_id === sampleId && r.start_pos > 0);
  const fullSampleSeq = sampleSequences.get(sampleId) || "";

  if (sampleResults.length === 0 || !fullSampleSeq) {
    mapContainer.innerHTML = `<p style="text-align: center; color: var(--text-muted); padding: 50px;">No valid primer alignments found for this sample.</p>`;
    return;
  }

  // 1. Sort and pre-process mismatches
  sampleResults.sort((a, b) => a.start_pos - b.start_pos);

  const parsedResults = sampleResults.map((p, index) => {
    const tokens = parseAlignmentTokens(p.alignment);
    // Ensure deletions show '-' in micro view
    tokens.forEach((t, k) => {
      if (t.consumesRef && t.isError && p.mapped_primer_seq && p.mapped_primer_seq[k] === '-') {
        t.text = '-';
      }
    });
    return { ...p, track: index, tokens };
  });

  const genomeLength = fullSampleSeq.length;
  const ROW_HEIGHT = 20;
  const ROW_GAP = 10;
  const RULER_HEIGHT = 40;
  const REF_SEQ_HEIGHT = 25; // Extra height for reference sequence when zoomed in
  const ZOOM_THRESHOLD = 12; // When zoom > 12px per base, switch to text mode

  // Calculate total vertical height needed for all primers
  const contentHeight = RULER_HEIGHT + REF_SEQ_HEIGHT + (parsedResults.length * (ROW_HEIGHT + ROW_GAP)) + 50;

  // 2. Setup the DOM structure for Native Scrolling
  const initialColors = getCanvasColors();
  const wrapper = document.createElement('div');
  wrapper.style.width = "100%";
  wrapper.style.height = "500px";
  wrapper.style.overflow = "auto";  // Native scrollbars
  wrapper.style.position = "relative";
  wrapper.style.backgroundColor = initialColors.wrapperBg;
  wrapper.style.borderRadius = "6px";

  // The "Spacer" forces the wrapper to have scrollbars matching the virtual genome size
  const spacer = document.createElement('div');
  spacer.style.position = "absolute";
  spacer.style.top = "0px";
  spacer.style.left = "0px";
  spacer.style.height = `${Math.max(500, contentHeight)}px`;
  spacer.style.zIndex = "-1";

  // The Canvas sticks to the top-left of the visible window
  const canvas = document.createElement('canvas');
  canvas.style.position = "sticky";
  canvas.style.top = "0px";
  canvas.style.left = "0px";
  canvas.style.cursor = "grab";

  wrapper.appendChild(spacer);
  wrapper.appendChild(canvas);
  mapContainer.appendChild(wrapper);

  // Setup tooltip
  const tooltip = document.createElement('div');
  tooltip.style.position = "fixed"; // Fixed prevents container overflow issues
  tooltip.style.display = "none";
  tooltip.style.backgroundColor = "rgba(17, 24, 39, 0.95)";
  tooltip.style.color = "#f9fafb";
  tooltip.style.padding = "12px";
  tooltip.style.borderRadius = "8px";
  tooltip.style.fontSize = "13px";
  tooltip.style.pointerEvents = "none"; // Let mouse events pass through to canvas
  tooltip.style.zIndex = "1000";
  tooltip.style.boxShadow = "0 10px 15px -3px rgba(0, 0, 0, 0.5)";
  tooltip.style.whiteSpace = "nowrap";
  tooltip.style.lineHeight = "1.5";
  wrapper.appendChild(tooltip); // Will be destroyed automatically when map is cleared

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Scale canvas for high-DPI/Retina screens
  const width = wrapper.clientWidth;
  const height = wrapper.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(dpr, dpr);

  // 3. State Variables
  let zoom = width / genomeLength; // Pixels per base pair
  spacer.style.width = `${genomeLength * zoom}px`; // Initialize horizontal scrollbar

  // 4. Main Render Loop
  function render() {
    if (!ctx) return;

    // Fetch latest palette based on active theme
    const colors = getCanvasColors();
    wrapper.style.backgroundColor = colors.wrapperBg;

    // The source of truth for position is the native scrollbars
    const panX = wrapper.scrollLeft / zoom;
    const panY = wrapper.scrollTop;

    ctx.clearRect(0, 0, width, height);

    const showText = zoom >= ZOOM_THRESHOLD;
    const stickyTopHeight = RULER_HEIGHT + (showText ? REF_SEQ_HEIGHT : 0);
    const startBp = panX;
    const endBp = panX + (width / zoom);

    // Primers
    ctx.font = "bold 14px monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";

    parsedResults.forEach(primer => {
      const yPos = stickyTopHeight + 10 + primer.track * (ROW_HEIGHT + ROW_GAP) - panY;
      // Culling: Don't draw if it's scrolled off-screen (above ruler or below canvas)
      if (yPos + ROW_HEIGHT < stickyTopHeight || yPos > height) return;

      const startX = (primer.start_pos - 1 - panX) * zoom;
      const primerWidth = (primer.end_pos - primer.start_pos + 1) * zoom;
      // Culling: Don't draw if it's panned completely off the left or right sides
      if (startX > width || startX + primerWidth < 0) return;

      if (showText) {
        // MICRO VIEW: Text
        let currentRefOffset = 0;

        for (const token of primer.tokens) {
          if (token.consumesRef) {
            const charX = startX + (currentRefOffset * zoom);
            if (charX + zoom >= 0 && charX <= width) {
              ctx.fillStyle = token.isError ? colors.boxMismatchBg : colors.boxMatchBg;
              ctx.fillRect(charX, yPos, zoom, ROW_HEIGHT);

              ctx.fillStyle = token.isError ? colors.boxMismatchText : colors.boxMatchText;
              ctx.fillText(token.text, charX + (zoom / 2), yPos + (ROW_HEIGHT / 2));
            }
            currentRefOffset++;
          } else {
            // Non-consuming insertion tick: draw mark between bases
            const tickX = startX + (currentRefOffset * zoom);
            if (tickX >= 0 && tickX <= width) {
              ctx.fillStyle = "#a855f7"; // Purple indicator
              ctx.fillRect(tickX - 1.5, yPos - 2, 3, ROW_HEIGHT + 4);
            }
          }
        }

        // Draw Primer ID to the left
        ctx.fillStyle = colors.primerIdText;
        ctx.textAlign = "right";
        ctx.fillText((primer.is_forward ? "➔ " : "⬅ ") + primer.primer_id, startX - 10, yPos + (ROW_HEIGHT / 2));
        ctx.textAlign = "center"; // Reset

      } else {
        // MACRO VIEW: Draw Polygons
        let color = "#22c55e";
        if (primer.status === "Low Risk") color = "#f59e0b";
        if (primer.status === "High Risk") color = "#ea580c";
        if (primer.status === "Failure") color = "#ef4444";

        ctx.fillStyle = color;
        const visualWidth = Math.max(primerWidth, 15);
        // Dynamically calculate the arrowhead size (max 8px, but smaller if the box is tiny)
        const arrowSize = Math.min(8, visualWidth * 0.5);

        ctx.beginPath();
        if (primer.is_forward) {
          ctx.moveTo(startX, yPos);
          ctx.lineTo(startX + visualWidth - arrowSize, yPos);
          ctx.lineTo(startX + visualWidth, yPos + (ROW_HEIGHT / 2));
          ctx.lineTo(startX + visualWidth - arrowSize, yPos + ROW_HEIGHT);
          ctx.lineTo(startX, yPos + ROW_HEIGHT);
        } else {
          ctx.moveTo(startX + visualWidth, yPos);
          ctx.lineTo(startX + arrowSize, yPos);
          ctx.lineTo(startX, yPos + (ROW_HEIGHT / 2));
          ctx.lineTo(startX + arrowSize, yPos + ROW_HEIGHT);
          ctx.lineTo(startX + visualWidth, yPos + ROW_HEIGHT);
        }
        ctx.fill();

        if (visualWidth > 30) {
          const text = primer.primer_id;
          ctx.font = "bold 10px sans-serif";
          const textWidth = ctx.measureText(text).width;
          if (visualWidth > textWidth + 15) {
            ctx.fillStyle = "white";
            ctx.textAlign = "left";
            ctx.fillText(text, startX + (primer.is_forward ? 5 : 10), yPos + (ROW_HEIGHT / 2));
            ctx.textAlign = "center";
          }
        }
      }
    });

    // Sticky Header & Reference Track
    ctx.fillStyle = colors.stickyBg;
    ctx.fillRect(0, 0, width, stickyTopHeight);
    ctx.beginPath();
    ctx.moveTo(0, stickyTopHeight);
    ctx.lineTo(width, stickyTopHeight);
    ctx.strokeStyle = colors.stickyBorder;
    ctx.stroke();

    // Reference sequence
    if (showText) {
      ctx.font = "bold 14px monospace";
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";

      const firstVisibleBp = Math.max(0, Math.floor(startBp));
      const lastVisibleBp = Math.min(genomeLength - 1, Math.ceil(endBp));

      for (let i = firstVisibleBp; i <= lastVisibleBp; i++) {
        const charX = (i - panX) * zoom;

        // Highlight Box
        ctx.fillStyle = colors.refBg;
        ctx.fillRect(charX, RULER_HEIGHT, zoom, REF_SEQ_HEIGHT);

        // Border separator
        ctx.strokeStyle = colors.refBorder;
        ctx.strokeRect(charX, RULER_HEIGHT, zoom, REF_SEQ_HEIGHT);

        // Letter
        ctx.fillStyle = colors.refText;
        ctx.fillText(fullSampleSeq[i].toUpperCase(), charX + (zoom / 2), RULER_HEIGHT + (REF_SEQ_HEIGHT / 2));
      }
    }

    // Ruler
    ctx.fillStyle = colors.rulerText;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";

    const targetBpSpacing = 100 / zoom;
    const magnitude = Math.pow(10, Math.floor(Math.log10(targetBpSpacing || 1)));
    const residual = targetBpSpacing / magnitude;
    let majorStep = 10;

    if (residual < 1.5) majorStep = 1 * magnitude;
    else if (residual < 3.5) majorStep = 2 * magnitude;
    else if (residual < 7.5) majorStep = 5 * magnitude;
    else majorStep = 10 * magnitude;

    if (majorStep < 10) majorStep = 10;
    const minorStep = Math.max(1, majorStep / 5);
    const firstMinorTick = Math.floor(startBp / minorStep) * minorStep;

    for (let i = firstMinorTick; i <= endBp + minorStep; i += minorStep) {
      const currentBp = Math.round(i);
      if (currentBp > genomeLength) break;

      const tickX = (currentBp - panX) * zoom;
      const isMajor = currentBp % Math.round(majorStep) === 0;

      ctx.beginPath();
      ctx.moveTo(tickX, RULER_HEIGHT);
      ctx.lineTo(tickX, RULER_HEIGHT - (isMajor ? 8 : 4));
      ctx.strokeStyle = isMajor ? colors.rulerMajorTick : colors.rulerMinorTick;
      ctx.stroke();

      if (isMajor) {
        ctx.fillText(currentBp.toLocaleString(), tickX, RULER_HEIGHT - 12);
      }
    }
  }

  activeRedrawFn = () => render();

  // 5. User Interaction (Zoom, Scroll, and Pan)

  // Automatically re-render when native scrollbars move
  wrapper.addEventListener('scroll', () => requestAnimationFrame(render));

  // Custom Drag-to-Pan (synchronizes with native scrollbars)
  let isDragging = false;
  let startX = 0, startY = 0;
  let startScrollLeft = 0, startScrollTop = 0;

  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    canvas.style.cursor = "grabbing";
    startX = e.pageX;
    startY = e.pageY;
    startScrollLeft = wrapper.scrollLeft;
    startScrollTop = wrapper.scrollTop;
  });

  // Hovel tooltip logic
  canvas.addEventListener('mousemove', (e) => {
    if (isDragging) {
      tooltip.style.display = "none";
      return;
    }

    const mouseX = e.offsetX;
    const mouseY = e.offsetY;

    // Current scroll state
    const panX = wrapper.scrollLeft / zoom;
    const panY = wrapper.scrollTop;
    const showText = zoom >= ZOOM_THRESHOLD;
    const stickyTopHeight = RULER_HEIGHT + (showText ? REF_SEQ_HEIGHT : 0);

    // Don't show tooltip if hovering over the sticky ruler/reference area
    if (mouseY < stickyTopHeight) {
      tooltip.style.display = "none";
      canvas.style.cursor = "grab";
      return;
    }

    let hoveredPrimer: (typeof parsedResults)[0] | null = null;

    // Loop through primers to see if mouse is inside their coordinates
    for (const primer of parsedResults) {
      const yPos = stickyTopHeight + 10 + primer.track * (ROW_HEIGHT + ROW_GAP) - panY;
      if (yPos + ROW_HEIGHT < stickyTopHeight || yPos > height) continue;

      const primerStartX = (primer.start_pos - 1 - panX) * zoom;
      const primerWidth = (primer.end_pos - primer.start_pos + 1) * zoom;

      // Use the same visualWidth math used for drawing to ensure the hitbox matches the graphics
      const visualWidth = Math.max(primerWidth, 15);

      if (mouseX >= primerStartX && mouseX <= primerStartX + visualWidth &&
          mouseY >= yPos && mouseY <= yPos + ROW_HEIGHT) {
        hoveredPrimer = primer;
        break;
      }
    }

    if (hoveredPrimer) {
      // Determine status color for tooltip text
      let color = "#4ade80";
      if (hoveredPrimer.status === "Low Risk") color = "#fbbf24";
      if (hoveredPrimer.status === "High Risk") color = "#f97316";
      if (hoveredPrimer.status === "Failure") color = "#f87171";

      // Sanitize the Primer ID
      const safePrimerId = escapeHTML(hoveredPrimer.primer_id);

      // Populate Tooltip
      tooltip.innerHTML = `
        <div style="margin-bottom: 6px; border-bottom: 1px solid #374151; padding-bottom: 4px;">
          <strong style="font-size: 15px;">${safePrimerId}</strong>
        </div>
        <div><strong>Position:</strong> ${hoveredPrimer.start_pos.toLocaleString()} - ${hoveredPrimer.end_pos.toLocaleString()} bp</div>
        <div><strong>Direction:</strong> ${hoveredPrimer.is_forward ? 'Forward ➔' : 'Reverse ⬅'}</div>
        <div><strong>Status:</strong> <span style="color: ${color}; font-weight: bold;">${hoveredPrimer.status}</span></div>
        <div><strong>Mismatches:</strong> ${hoveredPrimer.mismatches} (Gaps: ${hoveredPrimer.gaps})</div>
        <div><strong>CIGAR:</strong> <span style="font-family: monospace;">${hoveredPrimer.cigar || 'N/A'}</span></div>
      `;

      // Position tooltip relative to the actual screen (clientX/Y) so it doesn't clip
      let leftPos = e.clientX + 15;
      const topPos = e.clientY + 15;

      if (leftPos + 220 > window.innerWidth) {
        leftPos = e.clientX - 235;
      }

      tooltip.style.left = `${leftPos}px`;
      tooltip.style.top = `${topPos}px`;
      tooltip.style.display = "block";
      canvas.style.cursor = "pointer"; // Change cursor to indicate it's interactive
    } else {
      tooltip.style.display = "none";
      canvas.style.cursor = "grab";
    }
  });

  // Hide tooltip if the mouse leaves the canvas entirely
  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = "none";
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
    canvas.style.cursor = "grab";
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.pageX - startX;
    const dy = e.pageY - startY;
    // Changing scrollLeft/scrollTop automatically triggers the 'scroll' event and re-renders
    wrapper.scrollLeft = startScrollLeft - dx;
    wrapper.scrollTop = startScrollTop - dy;
  });

  // Zooming (Ctrl/Cmd + Scroll)
  wrapper.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // Allow normal native scrolling if no modifier key is pressed
    e.preventDefault();

    const mouseX = e.offsetX; // Mouse X relative to canvas
    const bpUnderMouse = (wrapper.scrollLeft + mouseX) / zoom;
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;

    zoom = Math.max(width / genomeLength, Math.min(zoom * zoomFactor, 30));

    // Stretch the invisible spacer to match the new zoom level
    spacer.style.width = `${genomeLength * zoom}px`;

    // Instantly adjust the scrollbar so the base pair under the mouse stays perfectly still
    wrapper.scrollLeft = (bpUnderMouse * zoom) - mouseX;

    requestAnimationFrame(render);
  }, { passive: false });

  // Initial render
  render();
}
