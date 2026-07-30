// src/main.ts
import ScannerWorker from './worker?worker';
import { openUrl } from "@tauri-apps/plugin-opener";

// UI Elements
const fwdInput = document.getElementById('fwd-key') as HTMLInputElement;
const revInput = document.getElementById('rev-key') as HTMLInputElement;
const primersFile = document.getElementById('primers-file') as HTMLInputElement;
const samplesFile = document.getElementById('samples-file') as HTMLInputElement;
const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
const exportCsvBtn = document.getElementById('export-csv-btn') as HTMLButtonElement;
const progressContainer = document.getElementById('progress-container') as HTMLDivElement;
const progressBar = document.getElementById('progress-bar') as HTMLDivElement;
const progressText = document.getElementById('progress-text') as HTMLSpanElement;

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

// Link to GitHub repo
document.getElementById("github-link").addEventListener("click", async (e) => {
  e.preventDefault();
  await openUrl("https://github.com/lucvzon/pcr-dropout-checker");
});

// Global State for Pagination
let allResults: any[] = [];
let currentPage = 1;
const ROWS_PER_PAGE = 50;

let sampleSequences = new Map<string, string>();

// Fast manual parser to keep sequences in JavaScript memory
function parseFastaToMap(fastaStr: string) {
    sampleSequences.clear();
    let currentId = "";
    let currentSeq = "";
    
    for (const line of fastaStr.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith('>')) {
            if (currentId) sampleSequences.set(currentId, currentSeq);
            currentId = t.substring(1).trim();
            currentSeq = "";
        } else {
            currentSeq += t.toLowerCase(); // Force to lowercase for standard alignment viewing
        }
    }
    if (currentId) sampleSequences.set(currentId, currentSeq);
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
// INPUT VALIDATION (Guardrails)
// -----------------------------------------
async function validateFastaFile(file: File, fileType: string): Promise<boolean> {
    // 1. Check File Extension
    const validExtensions = ['.fasta', '.fa', '.fna', '.txt'];
    const fileName = file.name.toLowerCase();
    const hasValidExtension = validExtensions.some(ext => fileName.endsWith(ext));

    if (!hasValidExtension) {
        alert(`❌ Invalid ${fileType} file: "${file.name}"\nPlease upload a .fasta, .fa, or .txt file.`);
        return false;
    }

    // 2. Peek at the content (Read only the first 100 bytes)
    try {
        const chunk = file.slice(0, 100);
        const text = await chunk.text();
        
        // A valid FASTA must start with '>' (ignoring leading whitespace/newlines)
        if (!text.trim().startsWith('>')) {
            alert(`❌ Format Error in ${fileType}: "${file.name}"\nThe file does not appear to be a valid FASTA format. It must start with a '>' character.`);
            return false;
        }
    } catch (e) {
        alert(`❌ Could not read the ${fileType} file: "${file.name}"`);
        return false;
    }

    return true; // Passed all checks!
}

// -----------------------------------------
// WORKER SETUP
// -----------------------------------------
const worker = new ScannerWorker();

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
			// --------------------------------------

			// Show the UI (Tabs and Results)
			tabNav.style.display = "flex";
			resultsContainer.style.display = "block";
		} else {
			alert("Error: " + response.error);
		}
    }
};

// -----------------------------------------
// TAB NAVIGATION LOGIC
// -----------------------------------------
tabBtnTable.addEventListener('click', () => {
    // Show Table, Hide Map
    viewTable.style.display = "block";
    viewMap.style.display = "none";
    
    // Style Active Button
    tabBtnTable.style.background = "white";
    tabBtnTable.style.border = "2px solid #d1d5db";
    tabBtnTable.style.borderBottom = "2px solid white";
    tabBtnTable.style.color = "#2563eb";
    
    // Style Inactive Button
    tabBtnMap.style.background = "#f3f4f6";
    tabBtnMap.style.border = "2px solid transparent";
    tabBtnMap.style.borderBottom = "none";
    tabBtnMap.style.color = "#6b7280";
});

tabBtnMap.addEventListener('click', () => {
    // Show Map, Hide Table
    viewMap.style.display = "block";
    viewTable.style.display = "none";
    
    // Style Active Button
    tabBtnMap.style.background = "white";
    tabBtnMap.style.border = "2px solid #d1d5db";
    tabBtnMap.style.borderBottom = "2px solid white";
    tabBtnMap.style.color = "#2563eb";
    
    // Style Inactive Button
    tabBtnTable.style.background = "#f3f4f6";
    tabBtnTable.style.border = "2px solid transparent";
    tabBtnTable.style.borderBottom = "none";
    tabBtnTable.style.color = "#6b7280";
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
    sumFail.innerText = failure.toString(); // High Risk/Failure maps to failure box
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
        let color = "#111827";
        if (res.status === "Perfect") color = "green";
        if (res.status === "Low Risk") color = "#d97706"; // Yellow/Orange
        if (res.status === "High Risk") color = "#ea580c"; // Dark Orange
        if (res.status === "Failure") color = "red";

        // Convert [T] into a red T, while keeping normal nucleotides black
        const formattedAlignment = res.alignment.replace(
            /\[([A-Z-])\]/g, 
            '<span style="color:red; font-weight:bold;">$1</span>'
        );

        tr.innerHTML = `
            <td style="padding: 10px;">${res.sample_id}</td>
            <td style="padding: 10px;">${res.primer_id}</td>
            <td style="padding: 10px;">${res.start_pos || '-'}</td>
            <td style="padding: 10px;">${res.end_pos || '-'}</td>
            <td style="padding: 10px; font-family: monospace; letter-spacing: 2px;">${formattedAlignment}</td>
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
        alert("Please upload BOTH a Primers file and a Samples file!");
        return;
    }

    // --- Run the Validation Guardrails ---
    const isPrimersValid = await validateFastaFile(pFile, "Primers");
    if (!isPrimersValid) return; // Stop execution if invalid

    const isSamplesValid = await validateFastaFile(sFile, "Samples");
    if (!isSamplesValid) return; // Stop execution if invalid

    runBtn.disabled = true;
    runBtn.innerText = "⏳ Reading files & Processing...";

    // Reset progress bar visually
    progressContainer.style.display = "block";
    progressBar.style.width = "0%";
    progressText.innerText = "0%";

    try {
        // Read the actual text content from the uploaded files
        const primersStr = await readTextFile(pFile);
        const samplesStr = await readTextFile(sFile);

        parseFastaToMap(samplesStr);

        // Send strings to the background Web Worker
        worker.postMessage({
            primersFasta: primersStr,
            samplesFasta: samplesStr,
            fwdKeyword: fwdInput.value,
            revKeyword: revInput.value
        });
    } catch (err) {
        alert("Failed to read files.");
        runBtn.disabled = false;
        runBtn.innerText = "Scan Genomes";
        progressContainer.style.display = "none";
    }
});

// -----------------------------------------
// EXPORT TO CSV
// -----------------------------------------
exportCsvBtn.addEventListener('click', () => {
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

    // 4. Create a virtual Blob and trigger standard browser download
    const blob = new Blob([csvContent], { type: 'text/tab-separated-values;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "primer_mismatch_results.tsv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
// PHASE 2: GENOME MAP DRAWING ENGINE
// -----------------------------------------
function drawGenomeMap(sampleId: string) {
    mapContainer.innerHTML = ""; // Clear old map

    const sampleResults = allResults.filter(
        r => r.sample_id === sampleId && r.start_pos > 0
    );

    if (sampleResults.length === 0) {
        mapContainer.innerHTML = `<p style="text-align: center; color: #9ca3af; padding: 50px;">No valid primer alignments found for this sample.</p>`;
        return;
    }

    const genomeLength = sampleResults[0].sample_length;
    let currentZoom = 1.0;
    
    // We base the initial canvas width on the container's actual size on screen
    const baseCanvasWidth = Math.max(1000, mapContainer.clientWidth - 40);

    // -----------------------------------------
    // A. INTERACTIVE WRAPPER (The Viewport)
    // -----------------------------------------
    const viewport = document.createElement('div');
    viewport.style.width = "100%";
    viewport.style.height = "500px"; // Fixed height keeps the UI clean
    viewport.style.overflow = "auto"; // Provides the scrollbars
    viewport.style.position = "relative";
    viewport.style.cursor = "grab";
    viewport.style.border = "1px solid #e5e7eb";
    viewport.style.backgroundColor = "#f8fafc";
    viewport.style.borderRadius = "6px";

    const canvas = document.createElement('div');
    canvas.style.position = "absolute";
    canvas.style.top = "0px";
    canvas.style.left = "0px";
    canvas.style.width = `${baseCanvasWidth}px`;
    // Space for ruler (40px) + space for all rows
    const ROW_HEIGHT = 28;
    const ROW_GAP = 8;
    canvas.style.height = `${60 + sampleResults.length * (ROW_HEIGHT + ROW_GAP)}px`; 

    // -----------------------------------------
    // B. DYNAMIC RULER
    // -----------------------------------------
    const ruler = document.createElement('div');
    ruler.style.position = "absolute";
    ruler.style.top = "0px";
    ruler.style.left = "0px";
    ruler.style.width = "100%";
    ruler.style.height = "30px";
    ruler.style.borderBottom = "2px solid #64748b";
    ruler.style.backgroundColor = "rgba(248, 250, 252, 0.9)"; // Slight transparency
    ruler.style.zIndex = "10";
    canvas.appendChild(ruler);

    function drawRuler() {
        ruler.innerHTML = ""; // Clear old ticks
        
        // Dynamically adjust number of ticks based on zoom level (max 100 ticks)
        let tickCount = Math.max(5, Math.floor(10 * currentZoom));
        if (tickCount > 100) tickCount = 100; 

        for (let i = 0; i <= tickCount; i++) {
            const bpLocation = Math.round((genomeLength / tickCount) * i);
            const leftPercent = (i / tickCount) * 100;

            const tick = document.createElement('div');
            tick.style.position = "absolute";
            tick.style.left = `${leftPercent}%`;
            tick.style.top = "10px";
            tick.style.height = "20px";
            tick.style.borderLeft = "1px solid #94a3b8";
            tick.style.fontSize = "11px";
            tick.style.color = "#64748b";
            tick.style.paddingLeft = "3px";
            
            // Format number neatly (e.g., 15.2k bp)
            tick.innerText = bpLocation > 1000 ? `${(bpLocation/1000).toFixed(1)}k` : `${bpLocation}`;
            ruler.appendChild(tick);
        }
    }

    // -----------------------------------------
    // C. Y-AXIS STAGGERING (1 Primer Per Row)
    // -----------------------------------------
    sampleResults.sort((a, b) => a.start_pos - b.start_pos);
    const primerTrackAssignments = sampleResults.map((p, index) => {
        return { primer: p, track: index };
    });

    // -----------------------------------------
    // D. DRAW PRIMER BARS & MISMATCH MARKERS
    // -----------------------------------------
    primerTrackAssignments.forEach(({ primer, track }) => {
        const leftPercent = (primer.start_pos / genomeLength) * 100;
        const widthPercent = ((primer.end_pos - primer.start_pos + 1) / genomeLength) * 100;
        const topPx = 40 + track * (ROW_HEIGHT + ROW_GAP); // 40px clears the ruler

        let bgColor = "#22c55e"; 
        if (primer.status === "Low Risk") bgColor = "#f59e0b"; 
        if (primer.status === "High Risk") bgColor = "#ea580c"; 
        if (primer.status === "Failure") bgColor = "#ef4444"; 

        const bar = document.createElement('div');
        bar.style.position = "absolute";
        bar.style.left = `${leftPercent}%`;
        bar.style.width = `max(${widthPercent}%, 2px)`; // Min width of 2px
        bar.style.top = `${topPx}px`;
        bar.style.height = `${ROW_HEIGHT}px`;
        bar.style.backgroundColor = bgColor;
        bar.style.borderRadius = "3px";
        bar.style.boxShadow = "0 1px 2px rgba(0,0,0,0.2)";
        bar.style.overflow = "hidden";
        bar.style.display = "flex";
        bar.style.alignItems = "center";
        
        const arrow = primer.is_forward ? "➔ " : "⬅ ";
        bar.innerHTML = `<span style="font-size: 10px; color: white; font-weight: bold; white-space: nowrap; padding-left: 4px;">${arrow}${primer.primer_id}</span>`;
        bar.title = `Primer: ${primer.primer_id}\nPos: ${primer.start_pos.toLocaleString()} - ${primer.end_pos.toLocaleString()} bp\nStatus: ${primer.status}\nMismatches: ${primer.mismatches}`;

        // Mismatch Markers
        if (primer.alignment && primer.alignment.includes('[')) {
            let baseIndex = 0; let i = 0;
            const primerLen = primer.end_pos - primer.start_pos + 1;
            while (i < primer.alignment.length) {
                if (primer.alignment[i] === '[') {
                    const marker = document.createElement('div');
                    marker.style.position = "absolute";
                    marker.style.left = `${(baseIndex / primerLen) * 100}%`;
                    marker.style.top = "0px";
                    marker.style.width = "2px"; 
                    marker.style.height = "100%";
                    marker.style.backgroundColor = "#000000"; 
                    bar.appendChild(marker);
                    i += 3; baseIndex++;
                } else {
                    baseIndex++; i++;
                }
            }
        }
        canvas.appendChild(bar);
    });

    viewport.appendChild(canvas);
    mapContainer.appendChild(viewport);

    // -----------------------------------------
    // E. EVENT LISTENERS (Zoom & Pan)
    // -----------------------------------------
    drawRuler(); // Draw initial ruler

    // Zooming (Ctrl + Scroll)
    viewport.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) return; 
        e.preventDefault(); 

        const zoomDelta = e.deltaY > 0 ? 0.8 : 1.25; 
        currentZoom = Math.max(1.0, Math.min(currentZoom * zoomDelta, 50.0)); 

        // Physically widen the canvas. The %-based left/width of primers auto-scale!
        canvas.style.width = `${baseCanvasWidth * currentZoom}px`;
        
        drawRuler(); 
    }, { passive: false });

    // Panning (Click & Drag)
    let isDragging = false;
    let startX: number, startY: number;
    let scrollLeft: number, scrollTop: number;

    viewport.addEventListener('mousedown', (e) => {
        isDragging = true;
        viewport.style.cursor = "grabbing";
        startX = e.pageX - viewport.offsetLeft;
        startY = e.pageY - viewport.offsetTop;
        scrollLeft = viewport.scrollLeft;
        scrollTop = viewport.scrollTop;
    });

    viewport.addEventListener('mouseleave', () => {
        isDragging = false;
        viewport.style.cursor = "grab";
    });

    viewport.addEventListener('mouseup', () => {
        isDragging = false;
        viewport.style.cursor = "grab";
    });

    viewport.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        
        const x = e.pageX - viewport.offsetLeft;
        const y = e.pageY - viewport.offsetTop;
        const walkX = (x - startX);
        const walkY = (y - startY);
        
        viewport.scrollLeft = scrollLeft - walkX;
        viewport.scrollTop = scrollTop - walkY;
    });
}

// -----------------------------------------
// EXPORT GAP-PADDED ALIGNMENT FASTA
// -----------------------------------------
const exportFastaBtn = document.getElementById('export-fasta-btn') as HTMLButtonElement;

exportFastaBtn.addEventListener('click', () => {
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

    // 3. Trigger Download
    const blob = new Blob([fastaContent], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${currentSample}_amplicon_alignment.fasta`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});
