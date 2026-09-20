import './style.css';
import { openUrl } from "@tauri-apps/plugin-opener";

import type { MatchResult } from './modules/types';
import { showToast } from './modules/toast';
import { readTextFile } from './modules/helpers';
import { preValidateFile, validateAndProcessFasta } from './modules/fasta';
import { initThemeManager } from './modules/theme';
import { setupDragAndDrop, setupGlobalDropGuards } from './modules/drag-drop';
import { ResultsTableController } from './modules/table';
import { drawGenomeMap, redrawActiveGenomeMap } from './modules/genome-map';
import { ScannerService } from './modules/scanner';
import { exportToTsv, exportToBed, exportToFasta } from './modules/export';

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
const viewTable = document.getElementById('view-table') as HTMLDivElement;
const viewMap = document.getElementById('view-map') as HTMLDivElement;
const resultsContainer = document.getElementById('results-container') as HTMLDivElement;

const sampleSelect = document.getElementById('sample-select') as HTMLSelectElement;
const mapContainer = document.getElementById('genome-map-container') as HTMLDivElement;

const autoDetectCb = document.getElementById('auto-detect-cb') as HTMLInputElement;
const keywordContainer = document.getElementById('keyword-container') as HTMLDivElement;

// --- State ---
let allResults: MatchResult[] = [];
let sampleSequences = new Map<string, string>();
let currentPrimerFileName = "primers";

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
  onThemeChanged: () => redrawActiveGenomeMap()
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

// --- Tabs Management ---
tabBtnTable.addEventListener('click', () => {
  viewTable.style.display = "block";
  viewMap.style.display = "none";

  tabBtnTable.style.background = "var(--bg-card)";
  tabBtnTable.style.border = "2px solid var(--border)";
  tabBtnTable.style.borderBottom = "2px solid var(--bg-card)";
  tabBtnTable.style.color = "var(--border-active)";

  tabBtnMap.style.background = "var(--bg-alt)";
  tabBtnMap.style.border = "2px solid transparent";
  tabBtnMap.style.borderBottom = "none";
  tabBtnMap.style.color = "var(--text-muted)";
});

tabBtnMap.addEventListener('click', () => {
  viewMap.style.display = "block";
  viewTable.style.display = "none";

  tabBtnMap.style.background = "var(--bg-card)";
  tabBtnMap.style.border = "2px solid var(--border)";
  tabBtnMap.style.borderBottom = "2px solid var(--bg-card)";
  tabBtnMap.style.color = "var(--border-active)";

  tabBtnTable.style.background = "var(--bg-alt)";
  tabBtnTable.style.border = "2px solid transparent";
  tabBtnTable.style.borderBottom = "none";
  tabBtnTable.style.color = "var(--text-muted)";

  if (sampleSelect.value) {
    drawGenomeMap(mapContainer, sampleSelect.value, allResults, sampleSequences);
  }
});

sampleSelect.addEventListener('change', () => {
  drawGenomeMap(mapContainer, sampleSelect.value, allResults, sampleSequences);
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
  runBtn.innerText = "⏳ Reading files & Processing...";
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