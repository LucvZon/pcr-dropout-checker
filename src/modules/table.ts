import type { MatchResult } from '../modules/types';
import { escapeHTML } from '../modules/helpers';

export interface TableElements {
  tableBody: HTMLTableSectionElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  pageInfo: HTMLSpanElement;
  sumTotal: HTMLHeadingElement;
  sumPerfect: HTMLHeadingElement;
  sumWarn: HTMLHeadingElement;
  sumFail: HTMLHeadingElement;
}

export class ResultsTableController {
  private elements: TableElements;
  private results: MatchResult[] = [];
  private currentPage = 1;
  private readonly rowsPerPage = 50;

  constructor(elements: TableElements) {
    this.elements = elements;

    this.elements.prevBtn.addEventListener('click', () => {
      if (this.currentPage > 1) {
        this.currentPage--;
        this.renderTable();
      }
    });

    this.elements.nextBtn.addEventListener('click', () => {
      const totalPages = Math.ceil(this.results.length / this.rowsPerPage);
      if (this.currentPage < totalPages) {
        this.currentPage++;
        this.renderTable();
      }
    });
  }

  public setData(results: MatchResult[]): void {
    this.results = results;
    this.currentPage = 1;
    this.updateDashboard();
    this.renderTable();
  }

  private updateDashboard(): void {
    let perfect = 0;
    let lowRisk = 0;
    let highRisk = 0;
    let failure = 0;

    for (const res of this.results) {
      if (res.status === "Perfect") perfect++;
      else if (res.status === "Low Risk") lowRisk++;
      else if (res.status === "High Risk") highRisk++;
      else failure++;
    }

    this.elements.sumTotal.innerText = this.results.length.toString();
    this.elements.sumPerfect.innerText = perfect.toString();
    this.elements.sumWarn.innerText = lowRisk.toString();
    this.elements.sumFail.innerText = (highRisk + failure).toString();
  }

  private renderTable(): void {
    const { tableBody, prevBtn, nextBtn, pageInfo } = this.elements;
    tableBody.innerHTML = "";

    // Calculate slices
    const startIndex = (this.currentPage - 1) * this.rowsPerPage;
    const endIndex = Math.min(startIndex + this.rowsPerPage, this.results.length);
    const totalPages = Math.ceil(this.results.length / this.rowsPerPage);

    // Get the slice of data for this specific page
    const pageData = this.results.slice(startIndex, endIndex);

    for (const res of pageData) {
      const tr = document.createElement('tr');
      tr.style.borderBottom = "1px solid #e5e7eb";

      // Determine Status Color
      let color = "var(--text-main)";
      if (res.status === "Perfect") color = "green";
      if (res.status === "Low Risk") color = "#d97706";
      if (res.status === "High Risk") color = "#ea580c";
      if (res.status === "Failure") color = "red";

      // Sanitize the raw IDs and alignment string
      const safeSampleId = escapeHTML(res.sample_id);
      const safePrimerId = escapeHTML(res.primer_id);
      const safeAlignment = escapeHTML(res.alignment);

      // Convert [T], [-], or {A} into red characters without brackets, while keeping normal nucleotides black
      const formattedAlignment = safeAlignment.replace(
        /\[([^\]]+)\]|\{([^}]+)\}/g,
        (_match, p1, p2) => `<span style="color:red; font-weight:bold;">${p1 ?? p2}</span>`
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
    pageInfo.innerText = `Page ${this.currentPage} of ${totalPages || 1}`;
    prevBtn.disabled = this.currentPage === 1;
    nextBtn.disabled = this.currentPage === totalPages || totalPages === 0;
  }
}
