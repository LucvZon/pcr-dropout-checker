import { showToast } from '../modules/toast';
import type { ProcessedFasta } from '../modules/types';

// Initial Pre-check (Size, Extension, and 4KB Integrity Check)
export async function preValidateFile(file: File, fileType: string): Promise<boolean> {
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
    const chunk = file.slice(0, 4096);
    const text = await chunk.text();
    
    if (!/^\s*[>;]/m.test(text)) {
      showToast(`Format Error: "${file.name}" does not appear to be a valid FASTA format.`, "error");
      return false;
    }
  } catch {
    showToast(`Could not read the ${fileType} file: "${file.name}"`, "error");
    return false;
  }

  return true;
}

// Parses raw FASTA content into a sanitized map while validating primer length and duplicate IDs
export function validateAndProcessFasta(rawText: string, fileType: string): ProcessedFasta | null {
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
        showToast(`Warning: Header "${currentId}" in ${fileType} has no sequence data and will be skipped.`, "warning");
        return;
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
      // No sequence ID yet
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
