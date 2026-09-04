use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use js_sys::Function;

// -----------------------------------------
// 1. DATA STRUCTURES (What we send to JS)
// -----------------------------------------
#[derive(Serialize, Deserialize)]
pub struct MatchResult {
    pub sample_id: String,
    pub primer_id: String,
    pub is_forward: bool,
    pub mismatches: usize,
    pub start_pos: usize,
    pub end_pos: usize,
    pub sample_length: usize,
    pub status: String,      // "Perfect", "Low Risk", "High Risk", "Failure"
    pub alignment: String,   // A visual string e.g. ".....X.." (X = mismatch)
    pub mapped_primer_seq: String,
}

// -----------------------------------------
// 2. HELPER FUNCTIONS
// -----------------------------------------
// Fast FASTA parser. Returns a Vec of (ID, Sequence)
fn parse_fasta(fasta_str: &str) -> Vec<(String, String)> {
    let mut records = Vec::new();
    let mut current_id = String::new();
    let mut current_seq = String::new();

    for line in fasta_str.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        
        if line.starts_with('>') {
            if !current_id.is_empty() {
                records.push((current_id.clone(), current_seq.clone()));
                current_seq.clear();
            }
            current_id = line[1..].to_string();
        } else {
            current_seq.push_str(&line.to_uppercase());
        }
    }
    if !current_id.is_empty() {
        records.push((current_id, current_seq));
    }
    records
}

// Advanced Reverse Complement (Handles all IUPAC codes)
fn reverse_complement(seq: &str) -> String {
    seq.chars().rev().map(|c| match c {
        'A' => 'T', 'T' => 'A', 'U' => 'A', 'C' => 'G', 'G' => 'C',
        'Y' => 'R', 'R' => 'Y', 'W' => 'W', 'S' => 'S', 'K' => 'M',
        'M' => 'K', 'D' => 'H', 'H' => 'D', 'V' => 'B', 'B' => 'V',
        'N' => 'N', '-' => '-',
        _ => c, // Keep unexpected characters as-is
    }).collect()
}

// Build a static lookup table for lightning-fast bitmask retrieval
const fn build_iupac_table() -> [u8; 256] {
    let mut table = [0; 256];
    table[b'A' as usize] = 0b00001;
    table[b'C' as usize] = 0b00010;
    table[b'G' as usize] = 0b00100;
    table[b'T' as usize] = 0b01000;
    table[b'U' as usize] = 0b01000;
    
    table[b'R' as usize] = 0b00101; // A or G
    table[b'Y' as usize] = 0b01010; // C or T
    table[b'S' as usize] = 0b00110; // G or C
    table[b'W' as usize] = 0b01001; // A or T
    table[b'K' as usize] = 0b01100; // G or T
    table[b'M' as usize] = 0b00011; // A or C
    
    table[b'B' as usize] = 0b01110; // C, G, T
    table[b'D' as usize] = 0b01101; // A, G, T
    table[b'H' as usize] = 0b01011; // A, C, T
    table[b'V' as usize] = 0b00111; // A, C, G
    
    table[b'N' as usize] = 0b01111; // Any base
    table[b'-' as usize] = 0b10000; // Gap matches gap
    table
}
const IUPAC_TABLE: [u8; 256] = build_iupac_table();

// Checks if two bases are biologically compatible
#[inline(always)]
fn is_iupac_match(primer_base: u8, ref_base: u8) -> bool {
    // Fast path: Exact letters match
    if primer_base == ref_base { return true; }
    
    // If the reference genome has an 'N', treat it as a mismatch. 
    // This prevents primers from magnetically snapping to N-stretches.
    if ref_base == b'N' { return false; }
    
    let mask_p = IUPAC_TABLE[primer_base as usize];
    let mask_r = IUPAC_TABLE[ref_base as usize];
    
    // If either letter is invalid/unknown (mask is 0), they don't match
    if mask_p == 0 || mask_r == 0 { return false; }
    
    // Do they share at least one concrete base?
    (mask_p & mask_r) != 0
}

/// Fast mismatch counter
#[inline]
fn count_mismatches_with_bailout(
    primer: &[u8], 
    window: &[u8], 
    max_allowed: usize
) -> Option<(usize, usize, bool)> {
    let len = primer.len();
    let mut total = 0;
    let mut critical = 0;
    let mut abs_3_broken = false;

    for i in 0..len {
        if !is_iupac_match(primer[i], window[i]) {
            total += 1;
            if total > max_allowed { return None; } // bail early
            
            if i >= len.saturating_sub(5) { critical += 1; }
            if i == len - 1 { abs_3_broken = true; }
        }
    }
    Some((total, critical, abs_3_broken))
}

/// Only called once for the winning position
fn build_alignment_string(primer: &[u8], window: &[u8]) -> String {
    let len = primer.len();
    let mut s = String::with_capacity(len + len / 4);
    for i in 0..len {
        if is_iupac_match(primer[i], window[i]) {
            s.push(window[i] as char);
        } else {
            s.push('[');
            s.push(window[i] as char);
            s.push(']');
        }
    }
    s
}

// Helper function to find the best alignment for a specific sequence
fn find_best_alignment(
    p_bytes: &[u8], 
    s_bytes: &[u8], 
    bound_total: usize, 
    bound_crit: usize
) -> Option<(usize, usize, bool, usize, String)> {
    let p_len = p_bytes.len();
    let mut best_mismatches = bound_total;
    let mut best_critical = bound_crit;
    let mut best_absolute_3 = false;
    let mut best_index = 0;
    let mut found_better = false;

    for i in 0..=(s_bytes.len() - p_len) {
        let window = &s_bytes[i..i + p_len];
        
        let Some((total, crit, abs_3)) = count_mismatches_with_bailout(p_bytes, window, best_mismatches) else { 
            continue; 
        };

        if total < best_mismatches || (total == best_mismatches && crit < best_critical) {
            best_mismatches = total;
            best_critical = crit;
            best_absolute_3 = abs_3;
            best_index = i;
            found_better = true;
        }
        
        if best_mismatches == 0 { break; }
    }

    if found_better || bound_total == usize::MAX {
        let best_window = &s_bytes[best_index..best_index + p_len];
        let best_alignment = build_alignment_string(p_bytes, best_window);
        Some((best_mismatches, best_critical, best_absolute_3, best_index, best_alignment))
    } else {
        None
    }
}

// -----------------------------------------
// 3. THE MAIN ENGINE (Called from Web Worker)
// -----------------------------------------
#[wasm_bindgen]
pub fn scan_genomes(
    primers_fasta: &str,
    samples_fasta: &str,
    fwd_keyword: &str,
    rev_keyword: &str,
    auto_detect: bool, // NEW PARAMETER
    progress_callback: &Function,
) -> String {
    let primers = parse_fasta(primers_fasta);
    let samples = parse_fasta(samples_fasta);
    let mut results: Vec<MatchResult> = Vec::new();

    let total_scans = primers.len() * samples.len();
    let mut completed_scans = 0;

    for (p_id, p_seq) in primers {
        let fwd_seq = p_seq.clone();
        let rev_seq = reverse_complement(&p_seq);
        let fwd_bytes = fwd_seq.as_bytes();
        let rev_bytes = rev_seq.as_bytes();
        let p_len = fwd_bytes.len();

        let is_fwd_keyword = p_id.contains(fwd_keyword);
        let is_rev_keyword = p_id.contains(rev_keyword);

        for (s_id, s_seq) in &samples {
            let s_bytes = s_seq.as_bytes();
            
            // SAFETY CHECKS
            if p_len == 0 || s_bytes.len() < p_len {
                results.push(MatchResult {
                    sample_id: s_id.clone(), primer_id: p_id.clone(), is_forward: true,
                    mismatches: 99, start_pos: 0, end_pos: 0, sample_length: s_bytes.len(),
                    status: if p_len == 0 { "Invalid Primer" } else { "Not Found (Too short)" }.to_string(),
                    alignment: "".to_string(),
                    mapped_primer_seq: String::from_utf8(fwd_bytes.to_vec()).unwrap_or_default(),
                });
                completed_scans += 1;
                continue;
            }

            let is_forward;
            let best_stats;
            let mapped_bytes;

            if auto_detect {
                // PASS 1: Unbounded Forward Scan
                let fwd_stats = find_best_alignment(fwd_bytes, s_bytes, usize::MAX, usize::MAX).unwrap();
                
                if fwd_stats.0 == 0 {
                    // Perfect forward match, skip reverse entirely
                    is_forward = true;
                    best_stats = fwd_stats;
                    mapped_bytes = fwd_bytes;
                } else {
                    // PASS 2: Bounded Reverse Scan
                    if let Some(rev_stats) = find_best_alignment(rev_bytes, s_bytes, fwd_stats.0, fwd_stats.1) {
                        is_forward = false;
                        best_stats = rev_stats;
                        mapped_bytes = rev_bytes;
                    } else {
                        // Reverse didn't beat forward (or tied, tie goes to forward)
                        is_forward = true;
                        best_stats = fwd_stats;
                        mapped_bytes = fwd_bytes;
                    }
                }
            } else {
                // FALLBACK TO STRICT KEYWORDS
                if is_rev_keyword && !is_fwd_keyword {
                    is_forward = false;
                    best_stats = find_best_alignment(rev_bytes, s_bytes, usize::MAX, usize::MAX).unwrap();
                    mapped_bytes = rev_bytes;
                } else {
                    is_forward = true;
                    best_stats = find_best_alignment(fwd_bytes, s_bytes, usize::MAX, usize::MAX).unwrap();
                    mapped_bytes = fwd_bytes;
                }
            }

            let (best_total_mismatches, best_critical, best_absolute_3, best_index, best_alignment) = best_stats;

            // --- GRADING LOGIC ---
            let status = if best_total_mismatches == 0 {
                "Perfect"
            } else if best_absolute_3 || best_critical >= 2 || best_total_mismatches > 5 {
                "Failure"
            } else if best_critical == 1 || best_total_mismatches >= 4 {
                "High Risk"
            } else {
                "Low Risk"
            };

            let (start, end) = (best_index + 1, best_index + p_len);

            results.push(MatchResult {
                sample_id: s_id.clone(),
                primer_id: p_id.clone(),
                is_forward,
                mismatches: best_total_mismatches,
                start_pos: start,
                end_pos: end,
                sample_length: s_bytes.len(),
                status: status.to_string(),
                alignment: best_alignment,
                mapped_primer_seq: String::from_utf8(mapped_bytes.to_vec()).unwrap(),
            });
            
            completed_scans += 1;
            let report_interval = (total_scans / 200).max(1);
            
            if completed_scans % report_interval == 0 || completed_scans == total_scans {
                let percent = (completed_scans as f64 / total_scans as f64) * 100.0;
                let _ = progress_callback.call1(&JsValue::null(), &JsValue::from_f64(percent));
            }
        }
    }
    serde_json::to_string(&results).unwrap()
}
