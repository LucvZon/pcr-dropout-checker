// src/main.ts
import ScannerWorker from './worker?worker';

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
const dashboard = document.getElementById('dashboard') as HTMLDivElement;
const sumTotal = document.getElementById('sum-total') as HTMLHeadingElement;
const sumPerfect = document.getElementById('sum-perfect') as HTMLHeadingElement;
const sumWarn = document.getElementById('sum-warn') as HTMLHeadingElement;
const sumFail = document.getElementById('sum-fail') as HTMLHeadingElement;

// Table Elements
const tableBody = document.getElementById('table-body') as HTMLTableSectionElement;
const prevBtn = document.getElementById('prev-btn') as HTMLButtonElement;
const nextBtn = document.getElementById('next-btn') as HTMLButtonElement;
const pageInfo = document.getElementById('page-info') as HTMLSpanElement;

// Global State for Pagination
let allResults: any[] = [];
let currentPage = 1;
const ROWS_PER_PAGE = 50;

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
        runBtn.innerText = "🚀 Scan Genomes";
        runBtn.disabled = false;
        
        // Hide progress bar once finished
        setTimeout(() => { progressContainer.style.display = "none"; }, 500);

        if (response.success) {
            allResults = response.data;
            updateDashboard();
            currentPage = 1;
            renderTable();
            dashboard.style.display = "block";
        } else {
            alert("Error: " + response.error);
        }
    }
};

// -----------------------------------------
// PAGINATION & RENDERING LOGIC
// -----------------------------------------
function updateDashboard() {
    let perfect = 0;
    let warn = 0;
    let fail = 0;

    for (const res of allResults) {
        if (res.status === "Perfect") perfect++;
        else if (res.status.includes("Warning")) warn++;
        else fail++;
    }

    sumTotal.innerText = allResults.length.toString();
    sumPerfect.innerText = perfect.toString();
    sumWarn.innerText = warn.toString();
    sumFail.innerText = fail.toString();
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
        if (res.status.includes("Warning")) color = "darkorange";
        if (res.status.includes("Not Found") || res.status.includes("Invalid")) color = "red";

        tr.innerHTML = `
            <td style="padding: 10px;">${res.sample_id}</td>
            <td style="padding: 10px;">${res.primer_id}</td>
            <td style="padding: 10px;">${res.start_pos || '-'}</td>
            <td style="padding: 10px;">${res.end_pos || '-'}</td>
            <td style="padding: 10px;">${res.mismatches === 99 ? '-' : res.mismatches}</td>
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
    }
});

// -----------------------------------------
// EXPORT TO CSV
// -----------------------------------------
exportCsvBtn.addEventListener('click', () => {
    if (allResults.length === 0) return;

    // 1. Create the CSV Header
    const headers = ["Sample ID", "Primer ID", "Orientation", "Start", "End", "Mismatches", "Status"];
    
    // 2. Map the data rows
    const rows = allResults.map(r => {
        return [
            r.sample_id,
            r.primer_id,
            r.is_forward ? "Forward" : "Reverse",
            r.start_pos || "N/A",
            r.end_pos || "N/A",
            r.mismatches === 99 ? "N/A" : r.mismatches,
            r.status
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
