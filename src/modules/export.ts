import type { MatchResult } from '../modules/types';
import { getFormattedDate, promptSaveFile } from '../modules/helpers';

export async function exportToTsv(results: MatchResult[], primerFileName: string): Promise<void> {
  if (results.length === 0) return;

  // 1. Create the CSV Header
  const headers = ["Sample ID", "Primer ID", "Orientation", "Start", "End", "Mismatches", "Status", "Alignment Map"];

  // 2. Map the data rows
  const rows = results.map(r => [
    r.sample_id,
    r.primer_id,
    r.is_forward ? "Forward" : "Reverse",
    r.start_pos || "N/A",
    r.end_pos || "N/A",
    r.mismatches === 99 ? "N/A" : r.mismatches,
    r.status,
    r.alignment
  ].join("\t")); // Join columns with tabs

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

  // 1. Write the Reference Sequence
  let fastaContent = `>${sampleId}\n${fullSampleSeq}\n`;

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
  const safeSampleName = sampleId.replace(/ /g, "_");
  const fileName = `${dateStr}_${safeSampleName}_alignment.fasta`;

  await promptSaveFile(fastaContent, fileName, 'fasta', 'text/plain');
}