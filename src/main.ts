// src/main.ts
import './style.css';
import ScannerWorker from './worker?worker';
import { openUrl } from "@tauri-apps/plugin-opener";
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

// UI Elements
const fwdInput = document.getElementById('fwd-key') as HTMLInputElement;
const revInput = document.getElementById('rev-key') as HTMLInputElement;
const primersFile = document.getElementById('primers-file') as HTMLInputElement;
const samplesFile = document.getElementById('samples-file') as HTMLInputElement;
const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
const exportCsvBtn = document.getElementById('export-csv-btn') as HTMLButtonElement;
const exportBedBtn = document.getElementById('export-bed-btn') as HTMLButtonElement;
const exportFastaBtn = document.getElementById('export-fasta-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const progressContainer = document.getElementById('progress-container') as HTMLDivElement;
const progressBar = document.getElementById('progress-bar') as HTMLDivElement;
const progressText = document.getElementById('progress-text') as HTMLSpanElement;
const themeToggleCb = document.getElementById('theme-toggle-cb') as HTMLInputElement;

// Dashboard Elements
const sumTotal = document.getElementById('sum-total') as HTMLHeadingElement;
const sumPerfect = document.getElementById('sum-perfect') as HTMLHeadingElement;
const sumWarn = document.getElementById('sum-warn') as HTMLHeadingElement;
const sumFail = document.getElementById('sum-fail') as HTMLHeadingElement;

// Tab Elements
const tabNav = document.getElementById('tab-nav') as HTMLDivElement;
const tabBtnTable = document.getElementById('tab-btn-table') as HTMLButtonElement;
const tabBtnMap = document.getElementById('tab-btn-map') as HTMLButtonElement;
const viewTable = document.getElementById('view-table') as HTMLDivElement;
const viewMap = document.getElementById('view-map') as HTMLDivElement;
const resultsContainer = document.getElementById('results-container') as HTMLDivElement;

// Map Elements
const sampleSelect = document.getElementById('sample-select') as HTMLSelectElement;
const mapContainer = document.getElementById('genome-map-container') as HTMLDivElement;

// Table Elements
const tableBody = document.getElementById('table-body') as HTMLTableSectionElement;
const prevBtn = document.getElementById('prev-btn') as HTMLButtonElement;
const nextBtn = document.getElementById('next-btn') as HTMLButtonElement;
const pageInfo = document.getElementById('page-info') as HTMLSpanElement;

// Remember User Settings (LocalStorage)
const autoDetectCb = document.getElementById('auto-detect-cb') as HTMLInputElement;
const keywordContainer = document.getElementById('keyword-container') as HTMLDivElement;

const savedFwd = localStorage.getItem('pcr-fwd-keyword');
const savedRev = localStorage.getItem('pcr-rev-keyword');
const savedAuto = localStorage.getItem('pcr-auto-detect');

if (savedFwd) fwdInput.value = savedFwd;
if (savedRev) revInput.value = savedRev;
if (savedAuto !== null) autoDetectCb.checked = savedAuto === 'true';

// Toggle the grayed-out UI for keywords
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

// Save settings when changed
fwdInput.addEventListener('input', () => localStorage.setItem('pcr-fwd-keyword', fwdInput.value));
revInput.addEventListener('input', () => localStorage.setItem('pcr-rev-keyword', revInput.value));
autoDetectCb.addEventListener('change', () => {
    localStorage.setItem('pcr-auto-detect', autoDetectCb.checked.toString());
    updateKeywordUI();
});

// Drag and Drop File Zones
// Prevent the app from navigating away if the user misses the drop zone,
// BUT allow the drop if they hit the invisible <input> fields
window.addEventListener("dragover", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'file') return;
    e.preventDefault();
});
window.addEventListener("drop", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'file') return;
    e.preventDefault();
});

// Centralized function to set the colors based on whether a file exists
function refreshZoneUI(zoneId: string, inputId: string, textId: string) {
    const zone = document.getElementById(zoneId) as HTMLDivElement;
    const input = document.getElementById(inputId) as HTMLInputElement;
    const textLabel = document.getElementById(textId) as HTMLParagraphElement;

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

function setupDragAndDrop(zoneId: string, inputId: string, textId: string) {
    const zone = document.getElementById(zoneId) as HTMLDivElement;
    const input = document.getElementById(inputId) as HTMLInputElement;

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

// Initialize the drop zones, passing in the text label IDs too
setupDragAndDrop('primers-zone', 'primers-file', 'primers-name');
setupDragAndDrop('samples-zone', 'samples-file', 'samples-name');

// Link to GitHub repo
document.getElementById("github-link")?.addEventListener("click", async (e) => {
  // Check if we are running inside the Tauri standalone app
  if ('__TAURI_INTERNALS__' in window) {
    e.preventDefault();
    try {
      // Must exactly match the case of the URL in src-tauri/capabilities/default.json
      await openUrl("https://github.com/LucvZon/pcr-dropout-checker");
    } catch (err) {
      console.error("Failed to open URL in Tauri:", err);
    }
  }
  // If we are in the web browser, we do not prevent default, 
  // so the native <a href="..."> tag handles opening the new tab normally
});

// Global State for Pagination
let allResults: any[] = [];
let currentPage = 1;
const ROWS_PER_PAGE = 50;

let sampleSequences = new Map<string, string>();
let currentPrimerFileName = "primers";

// Helper: Get Current Date in YYYY-MM-DD format
function getFormattedDate(): string {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Helper: Sanitize user input to prevent XSS
function escapeHTML(str: string): string {
    return String(str).replace(/[&<>'"]/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[tag] || tag));
}

// Helper: Universal "Save As..." Dialog
async function promptSaveFile(content: string, defaultFileName: string, fileExtension: string, mimeType: string) {
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
            const handle = await (window as any).showSaveFilePicker({
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
        } catch (err: any) {
            if (err.name !== 'AbortError') console.error("File Picker Error:", err);
            return; // User cancelled
        }
    }

    // 3. Web Browser Fallback (Firefox, Safari)
    // Note: Firefox will auto-download to the Downloads folder unless the user changes their browser settings.
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

// Helper: Read an uploaded File as a String
function readTextFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target?.result as string);
        reader.onerror = e => reject(e);
        reader.readAsText(file);
    });
}

// -----------------------------------------
// TOAST NOTIFICATION SYSTEM
// -----------------------------------------
function showToast(message: string, type: 'success' | 'error' | 'warning' = 'error', durationMs: number = 5000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300); // Wait for CSS fade transition
    }, durationMs);
}

// -----------------------------------------
// INPUT VALIDATION (Guardrails)
// -----------------------------------------
// 1. Initial Pre-check (Size, Extension, and 4KB Integrity Check)
async function preValidateFile(file: File, fileType: string): Promise<boolean> {
    if (file.size === 0) {
        showToast(`${fileType} file is empty (0 bytes).`, "error");
        return false;
    }
    if (file.size > 1024 * 1024 * 1024) { // 1 GB Limit
        showToast(`${fileType} file is too large (>1GB). Please use the CLI tool.`, "error");
        return false;
    }

    const validExtensions = ['.fasta', '.fa', '.fna', '.txt'];
    const fileName = file.name.toLowerCase();
    const hasValidExtension = validExtensions.some(ext => fileName.endsWith(ext));

    if (!hasValidExtension) {
        showToast(`Invalid ${fileType} file extension: "${file.name}". Use .fasta, .fa, .fna, or .txt`, "error");
        return false;
    }

    try {
        // Read the first 4KB to check integrity
        const chunk = file.slice(0, 4096);
        const text = await chunk.text();
        
        // A valid FASTA must have a '>' or ';' (comment) before sequence data
        if (!/^\s*[>;]/m.test(text)) {
            showToast(`Format Error: "${file.name}" does not appear to be a valid FASTA format.`, "error");
            return false;
        }
    } catch (e) {
        showToast(`Could not read the ${fileType} file: "${file.name}"`, "error");
        return false;
    }

    return true;
}

// 2. Deep Parsing & Content Validation
interface ProcessedFasta {
    sanitizedFasta: string;
    sequenceMap: Map<string, string>;
}

function validateAndProcessFasta(rawText: string, fileType: string): ProcessedFasta | null {
    const lines = rawText.split(/\r?\n/);
    const sequenceMap = new Map<string, string>();
    let currentId = "";
    let currentSeq = "";
    let sequenceCount = 0;
    
    const idCounts = new Map<string, number>();
    let validationFailed = false;

    const saveCurrent = () => {
        if (currentId) {
            if (currentSeq.trim() === "") {
                showToast(`Warning: Header "${currentId}" in ${fileType} has no sequence data.`, "warning");
            }

            // Hard Cap on Primer Length
            if (fileType === "Primers" && currentSeq.length > 200) {
                showToast(`Error: Primer "${currentId}" is too long (${currentSeq.length} bp). Max allowed is 200 bp.`, "error");
                validationFailed = true;
                return;
            }

            // Save to map (lowercased for UI consistency)
            sequenceMap.set(currentId, currentSeq.toLowerCase());
        }
    };

    for (let i = 0; i < lines.length; i++) {
        if (validationFailed) return null;

        const line = lines[i].trim();
        if (!line || line.startsWith(';')) continue; // Skip blanks and comments

        if (line.startsWith('>')) {
            saveCurrent();
            if (validationFailed) return null;
            
            let rawId = line.substring(1).trim();
            if (!rawId) rawId = "Unnamed_Sequence";

            // Handle Duplicates
            if (idCounts.has(rawId)) {
                const count = idCounts.get(rawId)! + 1;
                idCounts.set(rawId, count);
                const newId = `${rawId}_${count}`;
                showToast(`Warning: Duplicate ID "${rawId}" found in ${fileType}. Renamed to "${newId}".`, "warning");
                currentId = newId;
            } else {
                idCounts.set(rawId, 1);
                currentId = rawId;
            }
            currentSeq = "";
            sequenceCount++;
        } else {
            // No sequence ID yet!
            if (!currentId) {
                showToast(`Error in ${fileType} (Line ${i+1}): Sequence data found before a valid '>' header.`, "error");
                return null; 
            }

            // Invalid character check (Allow A-Z, a-z, and hyphens)
            if (!/^[A-Za-z-]+$/.test(line)) {
                showToast(`Error in ${fileType} (Line ${i+1}): Invalid characters found in sequence "${currentId}".`, "error");
                return null; 
            }

            currentSeq += line;
        }
    }
    saveCurrent();

    if (sequenceCount === 0) {
        showToast(`Error: No valid sequences found in ${fileType} file.`, "error");
        return null;
    }

    // Reconstruct a clean FASTA string to pass to the Rust Worker
    // (This guarantees the Rust parser won't trip on duplicate IDs or weird chars)
    let sanitizedFasta = "";
    for (const [id, seq] of sequenceMap.entries()) {
        sanitizedFasta += `>${id}\n${seq.toUpperCase()}\n`;
    }

    return { sanitizedFasta, sequenceMap };
}

// -----------------------------------------
// WORKER SETUP & CANCELLATION
// -----------------------------------------
let worker: Worker;

function setupWorker() {
    worker = new ScannerWorker();
    
    worker.onmessage = (event) => {
        const response = event.data;

        // Handle Progress Updates
        if (response.type === 'progress') {
            progressContainer.style.display = "block";
            progressBar.style.width = `${response.percent}%`;
            progressText.innerText = `${Math.round(response.percent)}%`;
            return; // Exit early, we aren't done yet!
        }

        // Handle Final Completion
        if (response.type === 'complete') {
            runBtn.innerText = "Scan Genomes";
            runBtn.disabled = false;
            cancelBtn.style.display = "none"; // Hide Cancel button
            
            // Hide progress bar once finished
            setTimeout(() => { progressContainer.style.display = "none"; }, 500);

            if (response.success) {
                allResults = response.data;
                updateDashboard();
                currentPage = 1;
                renderTable();
                
                // --- Populate the Map Dropdown ---
			    // 1. Get unique sample IDs
                const uniqueSamples = [...new Set(allResults.map(r => r.sample_id))];
                
			    // 2. Clear old dropdown options 
                sampleSelect.innerHTML = "";

                // 3. Add new options
                uniqueSamples.forEach(sampleId => {
                    const option = document.createElement("option");
                    option.value = sampleId;
                    option.textContent = sampleId;
                    sampleSelect.appendChild(option);
                });

                // Show the UI (Tabs and Results)
                tabNav.style.display = "flex";
                resultsContainer.style.display = "block";

                // Force the UI to reset to the Table Tab
                tabBtnTable.click();

            } else {
                alert("Error: " + response.error);
            }
        }
    };
}

// Initialize the first worker when the app loads
setupWorker();

// Cancel Button Logic
cancelBtn.addEventListener('click', () => {
    if (worker) {
        worker.terminate(); // 1. Kill the background thread instantly
        setupWorker();      // 2. Spin up a fresh worker for the next run
    }
    
    // Reset the UI
    runBtn.disabled = false;
    runBtn.innerText = "Scan Genomes";
    cancelBtn.style.display = "none";
    progressContainer.style.display = "none";
});

// -----------------------------------------
// TAB NAVIGATION LOGIC
// -----------------------------------------
tabBtnTable.addEventListener('click', () => {
    // Show Table, Hide Map
    viewTable.style.display = "block";
    viewMap.style.display = "none";
    
    // Style Active Button
    tabBtnTable.style.background = "var(--bg-card)";
    tabBtnTable.style.border = "2px solid var(--border)";
    tabBtnTable.style.borderBottom = "2px solid var(--bg-card)";
    tabBtnTable.style.color = "var(--border-active)";
    
    // Style Inactive Button
    tabBtnMap.style.background = "var(--bg-alt)";
    tabBtnMap.style.border = "2px solid transparent";
    tabBtnMap.style.borderBottom = "none";
    tabBtnMap.style.color = "var(--text-muted)";
});

tabBtnMap.addEventListener('click', () => {
    // Show Map, Hide Table
    viewMap.style.display = "block";
    viewTable.style.display = "none";
    
    // Style Active Button
    tabBtnMap.style.background = "var(--bg-card)";
    tabBtnMap.style.border = "2px solid var(--border)";
    tabBtnMap.style.borderBottom = "2px solid var(--bg-card)";
    tabBtnMap.style.color = "var(--border-active)";
    
    // Style Inactive Button
    tabBtnTable.style.background = "var(--bg-alt)";
    tabBtnTable.style.border = "2px solid transparent";
    tabBtnTable.style.borderBottom = "none";
    tabBtnTable.style.color = "var(--text-muted)";
});

// -----------------------------------------
// PAGINATION & RENDERING LOGIC
// -----------------------------------------
function updateDashboard() {
    let perfect = 0; let lowRisk = 0; let highRisk = 0; let failure = 0;

    for (const res of allResults) {
        if (res.status === "Perfect") perfect++;
        else if (res.status === "Low Risk") lowRisk++;
        else if (res.status === "High Risk") highRisk++;
        else failure++;
    }

    sumTotal.innerText = allResults.length.toString();
    sumPerfect.innerText = perfect.toString();
    sumWarn.innerText = lowRisk.toString(); // Low risk maps to warning box
    sumFail.innerText = (highRisk + failure).toString(); // High Risk/Failure maps to failure box
}

function renderTable() {
    tableBody.innerHTML = ""; // Clear old rows
    
    // Calculate slices
    const startIndex = (currentPage - 1) * ROWS_PER_PAGE;
    const endIndex = Math.min(startIndex + ROWS_PER_PAGE, allResults.length);
    const totalPages = Math.ceil(allResults.length / ROWS_PER_PAGE);
    
    // Get the slice of data for this specific page
    const pageData = allResults.slice(startIndex, endIndex);

    for (const res of pageData) {
        const tr = document.createElement('tr');
        tr.style.borderBottom = "1px solid #e5e7eb";

        // Determine Status Color
        let color = "var(--text-main)";
        if (res.status === "Perfect") color = "green";
        if (res.status === "Low Risk") color = "#d97706"; // Yellow/Orange
        if (res.status === "High Risk") color = "#ea580c"; // Dark Orange
        if (res.status === "Failure") color = "red";

        // Sanitize the raw IDs and alignment string
        const safeSampleId = escapeHTML(res.sample_id);
        const safePrimerId = escapeHTML(res.primer_id);
        const safeAlignment = escapeHTML(res.alignment);

        // Convert [T] into a red T, while keeping normal nucleotides black
        const formattedAlignment = safeAlignment.replace(
            /\[([A-Z0-9-])\]/gi, 
            '<span style="color:red; font-weight:bold;">$1</span>'
        );

        tr.innerHTML = `
            <td style="padding: 10px; word-break: break-all;">${safeSampleId}</td>
            <td style="padding: 10px; word-break: break-all;">${safePrimerId}</td>
            <td style="padding: 10px;">${res.start_pos || '-'}</td>
            <td style="padding: 10px;">${res.end_pos || '-'}</td>
            <td style="padding: 10px;">
                <div style="font-family: monospace; letter-spacing: 1px; width: 100%; overflow-x: auto; white-space: nowrap; padding-bottom: 4px;">
                    ${formattedAlignment}
                </div>
            </td>
            <td style="padding: 10px; font-weight: bold; color: ${color};">${res.status}</td>
        `;
        tableBody.appendChild(tr);
    }

    // Update buttons
    pageInfo.innerText = `Page ${currentPage} of ${totalPages || 1}`;
    prevBtn.disabled = currentPage === 1;
    nextBtn.disabled = currentPage === totalPages || totalPages === 0;
}

prevBtn.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; renderTable(); }
});

nextBtn.addEventListener('click', () => {
    const totalPages = Math.ceil(allResults.length / ROWS_PER_PAGE);
    if (currentPage < totalPages) { currentPage++; renderTable(); }
});

// -----------------------------------------
// MAIN RUN BUTTON TRIGGER
// -----------------------------------------
runBtn.addEventListener('click', async () => {
    const pFile = primersFile.files?.[0];
    const sFile = samplesFile.files?.[0];

    if (!pFile || !sFile) {
        showToast("Please upload BOTH a Primers file and a Samples file!", "warning");
        return;
    }

    // Pre-Validate Files (Size, extension, 4KB check)
    if (!(await preValidateFile(pFile, "Primers"))) return;
    if (!(await preValidateFile(sFile, "Samples"))) return;

    // Save the primer file name (stripping the extension) for export naming
    currentPrimerFileName = pFile.name.replace(/\.[^/.]+$/, "");

    runBtn.disabled = true;
    runBtn.innerText = "⏳ Reading files & Processing...";
    cancelBtn.style.display = "block";

    // Reset progress bar visually
    progressContainer.style.display = "block";
    progressBar.style.width = "0%";
    progressText.innerText = "0%";

    try {
        // Read Files
        const rawPrimersStr = await readTextFile(pFile);
        const rawSamplesStr = await readTextFile(sFile);

        // Deep Validate & Parse Content
        const processedPrimers = validateAndProcessFasta(rawPrimersStr, "Primers");
        const processedSamples = validateAndProcessFasta(rawSamplesStr, "Samples");

        // If either file failed deep validation, abort the run
        if (!processedPrimers || !processedSamples) {
            runBtn.disabled = false;
            runBtn.innerText = "Scan Genomes";
            progressContainer.style.display = "none";
            cancelBtn.style.display = "none";
            return;
        }

        // Save samples to global map for the genome map rendering
        sampleSequences = processedSamples.sequenceMap;

        // Send strings to the background Web Worker
        // Build the payload object
        const payload = {
            primersFasta: processedPrimers.sanitizedFasta,
            samplesFasta: processedSamples.sanitizedFasta,
            fwdKeyword: fwdInput.value,
            revKeyword: revInput.value,
            autoDetect: autoDetectCb.checked
        };

        // Send it to the worker
        worker.postMessage(payload);

    } catch (err) {
        showToast("An unexpected error occurred while reading the files.", "error");
        runBtn.disabled = false;
        runBtn.innerText = "Scan Genomes";
        progressContainer.style.display = "none";
        cancelBtn.style.display = "none";
    }
});

// -----------------------------------------
// EXPORT TO CSV
// -----------------------------------------
exportCsvBtn.addEventListener('click', async () => {
    if (allResults.length === 0) return;

    // 1. Create the CSV Header
    const headers = ["Sample ID", "Primer ID", "Orientation", "Start", "End", "Mismatches", "Status", "Alignment Map"];
    
    // 2. Map the data rows
    const rows = allResults.map(r => {
        return [
            r.sample_id,
            r.primer_id,
            r.is_forward ? "Forward" : "Reverse",
            r.start_pos || "N/A",
            r.end_pos || "N/A",
            r.mismatches === 99 ? "N/A" : r.mismatches,
            r.status,
            r.alignment
        ].join("\t"); // Join columns with tabs
    });

    // 3. Combine header and rows
    const csvContent = [headers.join("\t"), ...rows].join("\n");
    // Format the filename: YYYY-MM-DD_PrimerFileName_results.tsv (replace spaces with underscores)
    const dateStr = getFormattedDate();
    const safePrimerName = currentPrimerFileName.replace(/ /g, "_");
    const fileName = `${dateStr}_${safePrimerName}_results.tsv`;
    
    await promptSaveFile(csvContent, fileName, 'tsv', 'text/tab-separated-values');
});

// Redraw map when dropdown changes
sampleSelect.addEventListener('change', () => {
    drawGenomeMap(sampleSelect.value);
});

// Redraw map when tab is clicked
tabBtnMap.addEventListener('click', () => {
    viewMap.style.display = "block";
    viewTable.style.display = "none";
    // ... (existing button styling code) ...
    
    // DRAW THE MAP!
    if (sampleSelect.value) {
        drawGenomeMap(sampleSelect.value);
    }
});

// -----------------------------------------
// PHASE 2: CANVAS GENOME MAP ENGINE
// -----------------------------------------
function drawGenomeMap(sampleId: string) {
    mapContainer.innerHTML = ""; // Clear old map

    const sampleResults = allResults.filter(r => r.sample_id === sampleId && r.start_pos > 0);
    const fullSampleSeq = sampleSequences.get(sampleId) || "";
    
    if (sampleResults.length === 0 || !fullSampleSeq) {
        mapContainer.innerHTML = `<p style="text-align: center; color: #9ca3af; padding: 50px;">No valid primer alignments found for this sample.</p>`;
        return;
    }

    // 1. Sort and pre-process mismatches
    sampleResults.sort((a, b) => a.start_pos - b.start_pos);
    
    const parsedResults = sampleResults.map((p, index) => {
        const mismatchIndices = new Set<number>();
        let seqIndex = 0; let i = 0;
        while (i < p.alignment.length) {
            if (p.alignment[i] === '[') {
                mismatchIndices.add(seqIndex);
                i += 3; seqIndex++;
            } else { i++; seqIndex++; }
        }
        return { ...p, track: index, mismatchIndices };
    });

    const genomeLength = fullSampleSeq.length;
    const ROW_HEIGHT = 20;
    const ROW_GAP = 10;
    const RULER_HEIGHT = 40;
    const REF_SEQ_HEIGHT = 25; // Extra height for reference sequence when zoomed in
    const ZOOM_THRESHOLD = 12; // When zoom > 12px per base, switch to text mode!

    // Calculate total vertical height needed for all primers
    const contentHeight = RULER_HEIGHT + REF_SEQ_HEIGHT + (parsedResults.length * (ROW_HEIGHT + ROW_GAP)) + 50;

    // 2. Setup the DOM structure for Native Scrolling
    const wrapper = document.createElement('div');
    wrapper.style.width = "100%";
    wrapper.style.height = "500px";
    wrapper.style.overflow = "auto";       // Native scrollbars!
    wrapper.style.position = "relative";
    wrapper.style.backgroundColor = "#f8fafc";
    wrapper.style.borderRadius = "6px";
    
    // The "Spacer" forces the wrapper to have scrollbars matching the virtual genome size
    const spacer = document.createElement('div');
    spacer.style.position = "absolute";
    spacer.style.top = "0px";
    spacer.style.left = "0px";
    spacer.style.height = `${Math.max(500, contentHeight)}px`;
    spacer.style.zIndex = "-1"; // Hide behind canvas
    
    // The Canvas sticks to the top-left of the visible window
    const canvas = document.createElement('canvas');
    canvas.style.position = "sticky";
    canvas.style.top = "0px";
    canvas.style.left = "0px";
    canvas.style.cursor = "grab";

    wrapper.appendChild(spacer);
    wrapper.appendChild(canvas);
    mapContainer.appendChild(wrapper);


    // --- SETUP TOOLTIP ---
    const tooltip = document.createElement('div');
    tooltip.style.position = "fixed"; // Fixed prevents container overflow issues
    tooltip.style.display = "none";
    tooltip.style.backgroundColor = "rgba(17, 24, 39, 0.95)"; // Dark gray/black
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
        
        // The source of truth for position is the native scrollbars
        const panX = wrapper.scrollLeft / zoom;
        const panY = wrapper.scrollTop;
        
        ctx.clearRect(0, 0, width, height);

        const showText = zoom >= ZOOM_THRESHOLD;
        const stickyTopHeight = RULER_HEIGHT + (showText ? REF_SEQ_HEIGHT : 0);
        
        const startBp = panX;
        const endBp = panX + (width / zoom);

        // --- DRAW PRIMERS ---
        ctx.font = "bold 14px monospace";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";

        parsedResults.forEach(primer => {
            const yPos = stickyTopHeight + 10 + primer.track * (ROW_HEIGHT + ROW_GAP) - panY;
            
            // Culling: Don't draw if it's scrolled off-screen (above ruler or below canvas)
            if (yPos + ROW_HEIGHT < stickyTopHeight || yPos > height) return; // Vertical Cull
            
            const startX = (primer.start_pos - 1 - panX) * zoom;
            const primerWidth = (primer.end_pos - primer.start_pos + 1) * zoom;
            
            // Culling: Don't draw if it's panned completely off the left or right sides
            if (startX > width || startX + primerWidth < 0) return; // Horizontal Cull

            if (showText) {
                // MICRO VIEW: Text
                const seq = primer.mapped_primer_seq.toUpperCase();
                for (let i = 0; i < seq.length; i++) {
                    const charX = startX + (i * zoom);
                    if (charX + zoom < 0 || charX > width) continue;

                    const isMismatch = primer.mismatchIndices.has(i);

                    // Draw Box
                    ctx.fillStyle = isMismatch ? "#fee2e2" : "#e2e8f0";
                    ctx.fillRect(charX, yPos, zoom, ROW_HEIGHT);

                    // Draw Letter
                    ctx.fillStyle = isMismatch ? "#dc2626" : "#475569";
                    ctx.fillText(seq[i], charX + (zoom / 2), yPos + (ROW_HEIGHT / 2));
                }
                
                // Draw Primer ID to the left
                ctx.fillStyle = "#1e293b";
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

        // --- DRAW STICKY HEADER ---
        ctx.fillStyle = "rgba(248, 250, 252, 0.95)";
        ctx.fillRect(0, 0, width, stickyTopHeight);
        ctx.beginPath();
        ctx.moveTo(0, stickyTopHeight);
        ctx.lineTo(width, stickyTopHeight);
        ctx.strokeStyle = "#94a3b8";
        ctx.stroke();

        // --- DRAW REFERENCE SEQUENCE ---
        if (showText) {
            ctx.font = "bold 14px monospace";
            ctx.textBaseline = "middle";
            ctx.textAlign = "center";
            
            const firstVisibleBp = Math.max(0, Math.floor(startBp));
            const lastVisibleBp = Math.min(genomeLength - 1, Math.ceil(endBp));

            for (let i = firstVisibleBp; i <= lastVisibleBp; i++) {
                const charX = (i - panX) * zoom;
                
                // Highlight Box
                ctx.fillStyle = "#dbeafe";
                ctx.fillRect(charX, RULER_HEIGHT, zoom, REF_SEQ_HEIGHT);
                
                // Border separator
                ctx.strokeStyle = "#bfdbfe";
                ctx.strokeRect(charX, RULER_HEIGHT, zoom, REF_SEQ_HEIGHT);
                
                // Letter
                ctx.fillStyle = "#1e40af";
                ctx.fillText(fullSampleSeq[i].toUpperCase(), charX + (zoom / 2), RULER_HEIGHT + (REF_SEQ_HEIGHT / 2));
            }
        }

        // --- DRAW RULER ---
        ctx.fillStyle = "#475569";
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
        let minorStep = Math.max(1, majorStep / 5);

        const firstMinorTick = Math.floor(startBp / minorStep) * minorStep;
        
        for (let i = firstMinorTick; i <= endBp + minorStep; i += minorStep) {
            const currentBp = Math.round(i);
            if (currentBp > genomeLength) break;
            
            const tickX = (currentBp - panX) * zoom;
            const isMajor = currentBp % Math.round(majorStep) === 0;

            ctx.beginPath();
            ctx.moveTo(tickX, RULER_HEIGHT);
            ctx.lineTo(tickX, RULER_HEIGHT - (isMajor ? 8 : 4));
            ctx.strokeStyle = isMajor ? "#475569" : "#cbd5e1";
            ctx.stroke();

            if (isMajor) {
                ctx.fillText(currentBp.toLocaleString(), tickX, RULER_HEIGHT - 12);
            }
        }
    }

    // 5. User Interaction (Zoom, Scroll, and Pan)
    
    // Automatically re-render when native scrollbars move
    wrapper.addEventListener('scroll', () => requestAnimationFrame(render));

    // Custom Drag-to-Pan (synchronizes with native scrollbars!)
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

    // --- HOVER TOOLTIP LOGIC ---
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

        let hoveredPrimer = null;

        // Loop through primers to see if mouse is inside their coordinates
        for (const primer of parsedResults) {
            const yPos = stickyTopHeight + 10 + primer.track * (ROW_HEIGHT + ROW_GAP) - panY;
            if (yPos + ROW_HEIGHT < stickyTopHeight || yPos > height) continue;

            const startX = (primer.start_pos - 1 - panX) * zoom;
            const primerWidth = (primer.end_pos - primer.start_pos + 1) * zoom;
            
            // Use the same visualWidth math used for drawing to ensure the hitbox matches the graphics
            const visualWidth = Math.max(primerWidth, 15);

            if (mouseX >= startX && mouseX <= startX + visualWidth &&
                mouseY >= yPos && mouseY <= yPos + ROW_HEIGHT) {
                hoveredPrimer = primer;
                break;
            }
        }

        if (hoveredPrimer) {
            // Determine status color for tooltip text
            let color = "#4ade80"; // Bright Green
            if (hoveredPrimer.status === "Low Risk") color = "#fbbf24"; // Amber
            if (hoveredPrimer.status === "High Risk") color = "#f97316"; // Orange
            if (hoveredPrimer.status === "Failure") color = "#f87171"; // Red

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
                <div><strong>Mismatches:</strong> ${hoveredPrimer.mismatches}</div>
            `;
            
            // Position tooltip relative to the actual screen (clientX/Y) so it doesn't clip
            let leftPos = e.clientX + 15;
            let topPos = e.clientY + 15;
            
            // Prevent tooltip from flying off the right side of the screen
            if (leftPos + 200 > window.innerWidth) {
                leftPos = e.clientX - 215;
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

// -----------------------------------------
// EXPORT TO BED (BED6 + custom sequence column)
// -----------------------------------------
exportBedBtn.addEventListener('click', async () => {
    const currentSample = sampleSelect.value;
    if (!currentSample) return;

    // Filter results for the currently viewed sample (must be a valid alignment)
    const sampleResults = allResults.filter(
        r => r.sample_id === currentSample && r.start_pos > 0
    );
    if (sampleResults.length === 0) return;

    // Map to BED format
    // BED files are 0-indexed for start position, but the end position is exclusive
    const bedRows = sampleResults.map(r => {
        const chrom = r.sample_id;
        const chromStart = r.start_pos - 1; // Convert 1-indexed to 0-indexed
        const chromEnd = r.end_pos;         
        const name = r.primer_id;
        const score = r.mismatches;
        const strand = r.is_forward ? "+" : "-";
        const sequence = r.mapped_primer_seq;

        return [chrom, chromStart, chromEnd, name, score, strand, sequence].join("\t");
    });

    // BED files do not have header lines
    const bedContent = bedRows.join("\n");
    
    // Format the filename: YYYY-MM-DD_SampleID_primers.bed (replace spaces with underscores)
    const dateStr = getFormattedDate();
    const safeSampleName = currentSample.replace(/ /g, "_");
    const fileName = `${dateStr}_${safeSampleName}_primers.bed`;
    
    await promptSaveFile(bedContent, fileName, 'bed', 'text/plain');
});

// -----------------------------------------
// EXPORT GAP-PADDED ALIGNMENT FASTA
// -----------------------------------------
exportFastaBtn.addEventListener('click', async () => {
    const currentSample = sampleSelect.value;
    if (!currentSample) return;

    // Filter results for the currently viewed sample
    const sampleResults = allResults.filter(
        r => r.sample_id === currentSample && r.start_pos > 0
    );
    if (sampleResults.length === 0) return;

    // Get the full viral sample sequence
    const fullSampleSeq = sampleSequences.get(currentSample) || "";
    const genomeLen = fullSampleSeq.length;

    // 1. Write the Reference Sequence
    let fastaContent = `>${currentSample}\n${fullSampleSeq}\n`;

    // 2. Write the padded primers
    sampleResults.forEach(r => {
        const startIdx = r.start_pos - 1; // Convert 1-based to 0-based index
        const primerSeq = (r.mapped_primer_seq || "").toLowerCase();
        
        // Build the padded sequence string
        const leftPad = "-".repeat(startIdx);
        const rightPadLen = genomeLen - (startIdx + primerSeq.length);
        const rightPad = rightPadLen > 0 ? "-".repeat(rightPadLen) : "";
        
        const paddedSeq = leftPad + primerSeq + rightPad;
        
        fastaContent += `>${r.primer_id}\n${paddedSeq}\n`;
    });

    // Format the filename: YYYY-MM-DD_SampleID_alignment.fasta (replace spaces with underscores)
    const dateStr = getFormattedDate();
    const safeSampleName = currentSample.replace(/ /g, "_");
    const fileName = `${dateStr}_${safeSampleName}_alignment.fasta`;
    
    await promptSaveFile(fastaContent, fileName, 'fasta', 'text/plain');
});

// -----------------------------------------
// Dark/Light Theme Manager
// -----------------------------------------
function applyTheme(theme: string) {
    if (theme === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
        themeToggleCb.checked = isDark;
    } else {
        document.documentElement.setAttribute('data-theme', theme);
        themeToggleCb.checked = theme === 'dark';
    }
}

// Load saved theme (default to system on first visit)
let savedTheme = localStorage.getItem('pcr-theme') || 'system';
applyTheme(savedTheme);

// Listen for user toggling the switch
themeToggleCb.addEventListener('change', () => {
    const newTheme = themeToggleCb.checked ? 'dark' : 'light';
    localStorage.setItem('pcr-theme', newTheme);
    savedTheme = newTheme;
    applyTheme(newTheme);
});

// Automatically update if the OS changes theme while the app is open
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (savedTheme === 'system') applyTheme('system');
});
