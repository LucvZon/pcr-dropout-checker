import type { MatchResult } from '../modules/types';
import { getFormattedDate, promptSaveFile } from '../modules/helpers';
import { parseAlignmentTokens } from '../modules/genome-map';

export async function exportToTsv(results: MatchResult[], primerFileName: string): Promise<void> {
  if (results.length === 0) return;

  // 1. Create the CSV Header
  const headers = [
    "Sample ID",
    "Primer ID",
    "Orientation",
    "Start",
    "End",
    "Total Edits",
    "Gaps",
    "CIGAR",
    "Status",
    "Alignment Map",
  ];

  // 2. Map the data rows
  const rows = results.map(r => {
    // For TSV export, use [-] for deletions and [A] for insertions
    const tsvAlignment = r.alignment.replace(/\{([^}]+)\}/g, '[$1]');
    return [
      r.sample_id,
      r.primer_id,
      r.is_forward ? "Forward" : "Reverse",
      r.start_pos || "N/A",
      r.end_pos || "N/A",
      r.mismatches === 99 ? "N/A" : r.mismatches,
      r.gaps ?? 0,
      r.cigar ?? "N/A",
      r.status,
      tsvAlignment
    ].join("\t");
  }); // Join columns with tabs

  // 3. Combine header and rows
  const tsvContent = [headers.join("\t"), ...rows].join("\n");

  // Format the filename: YYYY-MM-DD_PrimerFileName_results.tsv (replace spaces with underscores)
  const dateStr = getFormattedDate();
  const safePrimerName = primerFileName.replace(/ /g, "_");
  const fileName = `${dateStr}_${safePrimerName}_results.tsv`;

  await promptSaveFile(tsvContent, fileName, 'tsv', 'text/tab-separated-values');
}

export async function exportToBed(sampleId: string, results: MatchResult[]): Promise<void> {
  if (!sampleId) return;

  // Filter results for the currently viewed sample (must be a valid alignment)
  const sampleResults = results.filter(r => r.sample_id === sampleId && r.start_pos > 0);
  if (sampleResults.length === 0) return;

  // Map to BED format
  // BED files are 0-indexed for start position, but the end position is exclusive
  const bedRows = sampleResults.map(r => {
    const chrom = r.sample_id;
    const chromStart = r.start_pos - 1;
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
  const safeSampleName = sampleId.replace(/ /g, "_");
  const fileName = `${dateStr}_${safeSampleName}_primers.bed`;

  await promptSaveFile(bedContent, fileName, 'bed', 'text/plain');
}

export async function exportToFasta(
  sampleId: string,
  results: MatchResult[],
  sampleSequences: Map<string, string>
): Promise<void> {
  if (!sampleId) return;

  // Filter results for the currently viewed sample
  const sampleResults = results.filter(r => r.sample_id === sampleId && r.start_pos > 0);
  if (sampleResults.length === 0) return;

  // Get the full viral sample sequence
  const fullSampleSeq = sampleSequences.get(sampleId) || "";
  const genomeLen = fullSampleSeq.length;
  if (!fullSampleSeq) return;

  // Parse alignments and map insertions / base mappings per primer
  interface ParsedPrimerAlignment {
    primer: MatchResult;
    insMap: Map<number, string>;
    baseMap: Map<number, string>;
  }

  const parsedPrimers: ParsedPrimerAlignment[] = sampleResults.map(r => {
    const tokens = parseAlignmentTokens(r.alignment);
    let currentRef = r.start_pos - 1; // 0-based reference index
    const insMap = new Map<number, string>();
    const baseMap = new Map<number, string>();

    for (const token of tokens) {
      const primerChar = token.text.toLowerCase();

      if (!token.consumesRef) {
        // Insertion in primer relative to reference at currentRef
        const prevIns = insMap.get(currentRef) || "";
        insMap.set(currentRef, prevIns + primerChar);
      } else {
        // Consumes reference base at currentRef
        baseMap.set(currentRef, primerChar);
        currentRef++;
      }
    }

    return { primer: r, insMap, baseMap };
  });

  // Calculate maximum insertion length at each reference position (0 to genomeLen)
  const maxIns = new Array<number>(genomeLen + 1).fill(0);
  for (const parsed of parsedPrimers) {
    for (const [pos, ins] of parsed.insMap.entries()) {
      if (pos >= 0 && pos <= genomeLen) {
        if (ins.length > maxIns[pos]) {
          maxIns[pos] = ins.length;
        }
      }
    }
  }

  // 1. Write the Reference Sequence (expanded with '-' for any primer insertions)
  let expandedRef = "";
  for (let i = 0; i < genomeLen; i++) {
    const insLen = maxIns[i];
    if (insLen > 0) {
      expandedRef += "-".repeat(insLen);
    }
    expandedRef += fullSampleSeq[i];
  }
  const trailingIns = maxIns[genomeLen];
  if (trailingIns > 0) {
    expandedRef += "-".repeat(trailingIns);
  }

  let fastaContent = `>${sampleId}\n${expandedRef}\n`;

  // 2. Write the padded primers aligned to the expanded reference
  for (const parsed of parsedPrimers) {
    let paddedSeq = "";
    for (let i = 0; i < genomeLen; i++) {
      const insLen = maxIns[i];
      if (insLen > 0) {
        const myIns = parsed.insMap.get(i) || "";
        paddedSeq += myIns + "-".repeat(insLen - myIns.length);
      }
      const base = parsed.baseMap.get(i);
      paddedSeq += base !== undefined ? base : "-";
    }
    if (trailingIns > 0) {
      const myIns = parsed.insMap.get(genomeLen) || "";
      paddedSeq += myIns + "-".repeat(trailingIns - myIns.length);
    }

    fastaContent += `>${parsed.primer.primer_id}\n${paddedSeq}\n`;
  }

  // Format the filename: YYYY-MM-DD_SampleID_alignment.fasta (replace spaces with underscores)
  const dateStr = getFormattedDate();
  const safeSampleName = sampleId.replace(/ /g, "_");
  const fileName = `${dateStr}_${safeSampleName}_alignment.fasta`;

  await promptSaveFile(fastaContent, fileName, 'fasta', 'text/plain');
}