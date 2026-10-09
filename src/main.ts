import './style.css';
import { openUrl } from "@tauri-apps/plugin-opener";

import type { MatchResult } from './modules/types';
import { showToast } from './modules/toast';
import { readTextFile } from './modules/helpers';
import { preValidateFile, validateAndProcessFasta } from './modules/fasta';
import { initThemeManager } from './modules/theme';
import { setupDragAndDrop, setupGlobalDropGuards } from './modules/drag-drop';
import { ResultsTableController } from './modules/table';
import { drawGenomeMap, redrawActiveGenomeMap, resetActiveGenomeMapView } from './modules/genome-map';
import { ScannerService } from './modules/scanner';
import { exportToTsv, exportToBed, exportToFasta } from './modules/export';
import { 
  drawHeatmapMatrix, 
  redrawActiveHeatmap, 
  resetActiveHeatmapView,
  zoomActiveHeatmap,
  exportHeatmapMatrixTsv, 
  type HeatmapState 
} from './modules/heatmap';

// --- UI DOM References ---
const fwdInput = document.getElementById('fwd-key') as HTMLInputElement;
const revInput = document.getElementById('rev-key') as HTMLInputElement;
const primersFile = document.getElementById('primers-file') as HTMLInputElement;
const samplesFile = document.getElementById('samples-file') as HTMLInputElement;
const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const exportCsvBtn = document.getElementById('export-csv-btn') as HTMLButtonElement;
const exportBedBtn = document.getElementById('export-bed-btn') as HTMLButtonElement;
const exportFastaBtn = document.getElementById('export-fasta-btn') as HTMLButtonElement;
const progressContainer = document.getElementById('progress-container') as HTMLDivElement;
const progressBar = document.getElementById('progress-bar') as HTMLDivElement;
const progressText = document.getElementById('progress-text') as HTMLSpanElement;
const themeToggleCb = document.getElementById('theme-toggle-cb') as HTMLInputElement;

const tabNav = document.getElementById('tab-nav') as HTMLDivElement;
const tabBtnTable = document.getElementById('tab-btn-table') as HTMLButtonElement;
const tabBtnMap = document.getElementById('tab-btn-map') as HTMLButtonElement;
const tabBtnMatrix = document.getElementById('tab-btn-matrix') as HTMLButtonElement;
const viewTable = document.getElementById('view-table') as HTMLDivElement;
const viewMap = document.getElementById('view-map') as HTMLDivElement;
const viewMatrix = document.getElementById('view-matrix') as HTMLDivElement;
const resultsContainer = document.getElementById('results-container') as HTMLDivElement;

const sampleSelect = document.getElementById('sample-select') as HTMLSelectElement;
const resetViewBtn = document.getElementById('reset-view-btn') as HTMLButtonElement;
const mapContainer = document.getElementById('genome-map-container') as HTMLDivElement;

const heatmapContainer = document.getElementById('heatmap-matrix-container') as HTMLDivElement;
const matrixResetViewBtn = document.getElementById('matrix-reset-view-btn') as HTMLButtonElement;
const matrixZoomInBtn = document.getElementById('matrix-zoom-in-btn') as HTMLButtonElement;
const matrixZoomOutBtn = document.getElementById('matrix-zoom-out-btn') as HTMLButtonElement;
const matrixSortCb = document.getElementById('matrix-sort-cb') as HTMLInputElement;
const matrixHidePerfectCb = document.getElementById('matrix-hide-perfect-cb') as HTMLInputElement;
const matrixExportBtn = document.getElementById('matrix-export-btn') as HTMLButtonElement;
const matrixStatsBadge = document.getElementById('matrix-stats-badge') as HTMLSpanElement;

const autoDetectCb = document.getElementById('auto-detect-cb') as HTMLInputElement;
const keywordContainer = document.getElementById('keyword-container') as HTMLDivElement;

// --- State ---
let allResults: MatchResult[] = [];
let sampleSequences = new Map<string, string>();
let currentPrimerFileName = "primers";

// --- Heatmap Settings & State ---
const savedMatrixSort = localStorage.getItem('pcr-matrix-sort');
const savedMatrixHidePerfect = localStorage.getItem('pcr-matrix-hide-perfect');

if (savedMatrixSort !== null) {
  matrixSortCb.checked = savedMatrixSort === 'true';
}
if (savedMatrixHidePerfect !== null) {
  matrixHidePerfectCb.checked = savedMatrixHidePerfect === 'true';
}

const heatmapState: HeatmapState = {
  sortByFailureRate: matrixSortCb.checked,
  hidePerfectSamples: matrixHidePerfectCb.checked,
};

// --- Services & Controllers ---
const scannerService = new ScannerService();
const tableController = new ResultsTableController({
  tableBody: document.getElementById('table-body') as HTMLTableSectionElement,
  prevBtn: document.getElementById('prev-btn') as HTMLButtonElement,
  nextBtn: document.getElementById('next-btn') as HTMLButtonElement,
  pageInfo: document.getElementById('page-info') as HTMLSpanElement,
  sumTotal: document.getElementById('sum-total') as HTMLHeadingElement,
  sumPerfect: document.getElementById('sum-perfect') as HTMLHeadingElement,
  sumWarn: document.getElementById('sum-warn') as HTMLHeadingElement,
  sumFail: document.getElementById('sum-fail') as HTMLHeadingElement,
});

// --- Theme Setup ---
initThemeManager({
  toggleElement: themeToggleCb,
  onThemeChanged: () => {
    redrawActiveGenomeMap();
    redrawActiveHeatmap();
  }
});

// --- Keyword & Auto-detect Settings ---
const savedFwd = localStorage.getItem('pcr-fwd-keyword');
const savedRev = localStorage.getItem('pcr-rev-keyword');
const savedAuto = localStorage.getItem('pcr-auto-detect');

if (savedFwd) fwdInput.value = savedFwd;
if (savedRev) revInput.value = savedRev;
if (savedAuto !== null) autoDetectCb.checked = savedAuto === 'true';

function updateKeywordUI() {
  if (autoDetectCb.checked) {
    keywordContainer.style.opacity = "0.4";
    keywordContainer.style.pointerEvents = "none";
  } else {
    keywordContainer.style.opacity = "1";
    keywordContainer.style.pointerEvents = "auto";
  }
}
updateKeywordUI();

fwdInput.addEventListener('input', () => localStorage.setItem('pcr-fwd-keyword', fwdInput.value));
revInput.addEventListener('input', () => localStorage.setItem('pcr-rev-keyword', revInput.value));
autoDetectCb.addEventListener('change', () => {
  localStorage.setItem('pcr-auto-detect', autoDetectCb.checked.toString());
  updateKeywordUI();
});

// --- File Drag & Drop ---
setupGlobalDropGuards();
setupDragAndDrop('primers-zone', 'primers-file', 'primers-name');
setupDragAndDrop('samples-zone', 'samples-file', 'samples-name');

// --- External Links ---
document.getElementById("github-link")?.addEventListener("click", async (e) => {
  if ('__TAURI_INTERNALS__' in window) {
    e.preventDefault();
    try {
      await openUrl("https://github.com/LucvZon/pcr-dropout-checker");
    } catch (err) {
      console.error("Failed to open URL in Tauri:", err);
    }
  }
});

// --- Heatmap UI Refresh ---
function renderHeatmap() {
  heatmapState.sortByFailureRate = matrixSortCb.checked;
  heatmapState.hidePerfectSamples = matrixHidePerfectCb.checked;

  const uniquePrimers = new Set(allResults.map(r => r.primer_id)).size;
  const uniqueSamples = new Set(allResults.map(r => r.sample_id)).size;
  matrixStatsBadge.textContent = `${uniquePrimers} Primers × ${uniqueSamples} Samples`;

  drawHeatmapMatrix(heatmapContainer, allResults, heatmapState);
}

// --- Tabs Management ---
function setTabActive(activeTab: 'table' | 'map' | 'matrix') {
  viewTable.style.display = activeTab === 'table' ? "block" : "none";
  viewMap.style.display = activeTab === 'map' ? "block" : "none";
  viewMatrix.style.display = activeTab === 'matrix' ? "block" : "none";

  const tabs = [
    { key: 'table', btn: tabBtnTable },
    { key: 'map', btn: tabBtnMap },
    { key: 'matrix', btn: tabBtnMatrix },
  ];

  for (const { key, btn } of tabs) {
    if (key === activeTab) {
      btn.style.background = "var(--bg-card)";
      btn.style.border = "2px solid var(--border)";
      btn.style.borderBottom = "2px solid var(--bg-card)";
      btn.style.color = "var(--border-active)";
    } else {
      btn.style.background = "var(--bg-alt)";
      btn.style.border = "2px solid transparent";
      btn.style.borderBottom = "none";
      btn.style.color = "var(--text-muted)";
    }
  }
}

tabBtnTable.addEventListener('click', () => setTabActive('table'));

tabBtnMap.addEventListener('click', () => {
  setTabActive('map');
  if (sampleSelect.value) {
    drawGenomeMap(mapContainer, sampleSelect.value, allResults, sampleSequences);
  }
});

tabBtnMatrix.addEventListener('click', () => {
  setTabActive('matrix');
  renderHeatmap();
});

sampleSelect.addEventListener('change', () => {
  drawGenomeMap(mapContainer, sampleSelect.value, allResults, sampleSequences);
});

resetViewBtn?.addEventListener('click', () => {
  resetActiveGenomeMapView();
});

// --- Heatmap Controls ---
matrixResetViewBtn.addEventListener('click', () => {
  resetActiveHeatmapView();
});

matrixZoomInBtn.addEventListener('click', () => {
  zoomActiveHeatmap(1.25);
});

matrixZoomOutBtn.addEventListener('click', () => {
  zoomActiveHeatmap(0.8);
});

matrixSortCb.addEventListener('change', () => {
  localStorage.setItem('pcr-matrix-sort', matrixSortCb.checked.toString());
  heatmapState.sortByFailureRate = matrixSortCb.checked;
  renderHeatmap();
});

matrixHidePerfectCb.addEventListener('change', () => {
  localStorage.setItem('pcr-matrix-hide-perfect', matrixHidePerfectCb.checked.toString());
  heatmapState.hidePerfectSamples = matrixHidePerfectCb.checked;
  renderHeatmap();
});

matrixExportBtn.addEventListener('click', () => {
  exportHeatmapMatrixTsv(allResults, heatmapState);
});

// --- Scan Execution ---
function resetScanUI() {
  runBtn.disabled = false;
  runBtn.innerText = "Scan Genomes";
  cancelBtn.style.display = "none";
  progressContainer.style.display = "none";
}

runBtn.addEventListener('click', async () => {
  const pFile = primersFile.files?.[0];
  const sFile = samplesFile.files?.[0];

  if (!pFile || !sFile) {
    showToast("Please upload BOTH a Primers file and a Samples file!", "warning");
    return;
  }

  if (!(await preValidateFile(pFile, "Primers"))) return;
  if (!(await preValidateFile(sFile, "Samples"))) return;

  currentPrimerFileName = pFile.name.replace(/\.[^/.]+$/, "");

  runBtn.disabled = true;
  runBtn.innerText = "Reading files & Processing...";
  cancelBtn.style.display = "block";

  progressContainer.style.display = "block";
  progressBar.style.width = "0%";
  progressText.innerText = "0%";

  try {
    const rawPrimersStr = await readTextFile(pFile);
    const rawSamplesStr = await readTextFile(sFile);

    const processedPrimers = validateAndProcessFasta(rawPrimersStr, "Primers");
    const processedSamples = validateAndProcessFasta(rawSamplesStr, "Samples");

    if (!processedPrimers || !processedSamples) {
      resetScanUI();
      return;
    }

    sampleSequences = processedSamples.sequenceMap;

    const encoder = new TextEncoder();
    const primersBuffer = encoder.encode(processedPrimers.sanitizedFasta).buffer;
    const samplesBuffer = encoder.encode(processedSamples.sanitizedFasta).buffer;

    scannerService.runScan(
      {
        primersBuffer,
        samplesBuffer,
        fwdKeyword: fwdInput.value,
        revKeyword: revInput.value,
        autoDetect: autoDetectCb.checked,
      },
      {
        onProgress: (percent) => {
          progressContainer.style.display = "block";
          progressBar.style.width = `${percent}%`;
          progressText.innerText = `${Math.round(percent)}%`;
        },
        onComplete: (results) => {
          resetScanUI();
          allResults = results;

          tableController.setData(allResults);

          // Populate sample select options
          const uniqueSamples = [...new Set(allResults.map(r => r.sample_id))];
          sampleSelect.innerHTML = "";
          uniqueSamples.forEach(sampleId => {
            const option = document.createElement("option");
            option.value = sampleId;
            option.textContent = sampleId;
            sampleSelect.appendChild(option);
          });

          tabNav.style.display = "flex";
          resultsContainer.style.display = "block";
          tabBtnTable.click();
        },
        onError: (err) => {
          resetScanUI();
          showToast(`Worker Error: ${err}`, "error");
        }
      }
    );
  } catch {
    showToast("An unexpected error occurred while reading the files.", "error");
    resetScanUI();
  }
});

cancelBtn.addEventListener('click', () => {
  scannerService.cancel();
  resetScanUI();
});

// --- Exports ---
exportCsvBtn.addEventListener('click', () => {
  exportToTsv(allResults, currentPrimerFileName);
});

exportBedBtn.addEventListener('click', () => {
  exportToBed(sampleSelect.value, allResults);
});

exportFastaBtn.addEventListener('click', () => {
  exportToFasta(sampleSelect.value, allResults, sampleSequences);
});
