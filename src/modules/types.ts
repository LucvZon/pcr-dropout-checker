export interface MatchResult {
  sample_id: string;
  primer_id: string;
  is_forward: boolean;
  mismatches: number;
  start_pos: number;
  end_pos: number;
  sample_length: number;
  status: "Perfect" | "Low Risk" | "High Risk" | "Failure" | string;
  alignment: string;
  mapped_primer_seq: string;
}

export interface ProcessedFasta {
  sanitizedFasta: string;
  sequenceMap: Map<string, string>;
}

export interface ScanPayload {
  primersBuffer: ArrayBuffer;
  samplesBuffer: ArrayBuffer;
  fwdKeyword: string;
  revKeyword: string;
  autoDetect: boolean;
}