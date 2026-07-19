// src/main.ts
import ScannerWorker from './worker?worker';

// UI Elements
const fwdInput = document.getElementById('fwd-key') as HTMLInputElement;
const revInput = document.getElementById('rev-key') as HTMLInputElement;
const primersFile = document.getElementById('primers-file') as HTMLInputElement;
const samplesFile = document.getElementById('samples-file') as HTMLInputElement;
const runBtn = document.getElementById('run-btn') as HTMLButtonElement;

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
    runBtn.innerText = "🚀 Scan Genomes";
    runBtn.disabled = false;

    if (response.success) {
        allResults = response.data;
        updateDashboard();
        
        // Reset to page 1 and render table
        currentPage = 1;
        renderTable();
        dashboard.style.display = "block";
    } else {
        alert("Error: " + response.error);
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
        runBtn.innerText = "🚀 Scan Genomes";
    }
});
