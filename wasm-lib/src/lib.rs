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
    pub status: String,      // "Perfect", "Low Risk", "High Risk", "Failure"
    pub alignment: String,   // A visual string e.g. ".....X.." (X = mismatch)
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

// Position-Aware Alignment Evaluator
// Returns: (Total Mismatches, Mismatches in 3' Zone, Is absolute 3' broken, Alignment String)
fn evaluate_alignment(primer: &[u8], window: &[u8]) -> (usize, usize, bool, String) {
    let len = primer.len();
    let mut total_mismatches = 0;
    let mut critical_mismatches = 0;
    let mut absolute_3_prime_broken = false;
    let mut alignment_str = String::with_capacity(len);

    for i in 0..len {
        if is_iupac_match(primer[i], window[i]) {
            alignment_str.push('.'); // Match
        } else {
            alignment_str.push('X'); // Mismatch
            total_mismatches += 1;
            
            // Check if we are in the 3' Critical Zone (last 5 bases)
            // Note: Primers are always 5' -> 3', so the end of the string is the 3' end.
            if i >= len.saturating_sub(5) {
                critical_mismatches += 1;
            }
            // Check absolute last base
            if i == len - 1 {
                absolute_3_prime_broken = true;
            }
        }
    }
    (total_mismatches, critical_mismatches, absolute_3_prime_broken, alignment_str)
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
    progress_callback: &Function,
) -> String {
    let primers = parse_fasta(primers_fasta);
    let samples = parse_fasta(samples_fasta);
    let mut results: Vec<MatchResult> = Vec::new();

    // Calculate total work for the progress bar
    let total_scans = primers.len() * samples.len();
    let mut completed_scans = 0;

    for (p_id, p_seq) in primers {
        let is_forward = p_id.contains(fwd_keyword);
        let is_reverse = p_id.contains(rev_keyword);

        // If neither keyword is found, assume Forward to be safe
        let search_seq = if is_reverse && !is_forward {
            reverse_complement(&p_seq)
        } else {
            p_seq.clone()
        };

        let p_bytes = search_seq.as_bytes();
        let p_len = p_bytes.len();

        // Process Primers
        for (s_id, s_seq) in &samples {
            let s_bytes = s_seq.as_bytes();
            
            // SAFETY CHECK 1: Is the primer empty?
            if p_len == 0 {
                results.push(MatchResult {
                    sample_id: s_id.clone(),
                    primer_id: p_id.clone(),
                    is_forward: !is_reverse || is_forward,
                    mismatches: 99,
                    start_pos: 0, end_pos: 0, 
                    status: "Invalid Primer".to_string(),
                    alignment: "".to_string(),
                });
                completed_scans += 1;
                continue;
            }

            // SAFETY CHECK 2: Is the sample empty, or smaller than the primer?
            if s_bytes.len() < p_len {
                results.push(MatchResult {
                    sample_id: s_id.clone(),
                    primer_id: p_id.clone(),
                    is_forward: !is_reverse || is_forward,
                    mismatches: 99,
                    start_pos: 0, end_pos: 0, 
                    status: "Not Found (Too short)".to_string(),
                    alignment: "".to_string(),
                });
                completed_scans += 1;
                continue;
            }
            
            if p_len == 0 || s_bytes.len() < p_len {
                results.push(MatchResult {
                    sample_id: s_id.clone(), primer_id: p_id.clone(), is_forward: !is_reverse || is_forward,
                    mismatches: 99, start_pos: 0, end_pos: 0,
                    status: "Failure".to_string(), alignment: "".to_string(),
                });
                completed_scans += 1;
                continue;
            }

            let mut best_total_mismatches = usize::MAX;
            let mut best_critical = 0;
            let mut best_absolute_3 = false;
            let mut best_index = 0;
            let mut best_alignment = String::new();

            // Slide window across genome
            for i in 0..=(s_bytes.len() - p_len) {
                let window = &s_bytes[i..(i + p_len)];
                
                // Fast path: if lengths match, evaluate
                let (total, crit, abs_3, aln) = evaluate_alignment(p_bytes, window);
                
                // We optimize for lowest total mismatches. 
                // (If there is a tie, we prefer the one with fewer critical mismatches)
                if total < best_total_mismatches || (total == best_total_mismatches && crit < best_critical) {
                    best_total_mismatches = total;
                    best_critical = crit;
                    best_absolute_3 = abs_3;
                    best_index = i;
                    best_alignment = aln;
                }
                
                if best_total_mismatches == 0 { break; } // Perfect match found
            }

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

            // If it's not found, coordinates are 0. Otherwise, 1-based coords.
            let (start, end) = if best_total_mismatches > 5 {
                (0, 0)
            } else {
                (best_index + 1, best_index + p_len)
            };

            results.push(MatchResult {
                sample_id: s_id.clone(),
                primer_id: p_id.clone(),
                is_forward: !is_reverse || is_forward,
                mismatches: best_total_mismatches,
                start_pos: start,
                end_pos: end,
                status: status.to_string(),
                alignment: best_alignment,
            });
            
            // Progress Bar Logic
            completed_scans += 1;
            
            // Performance trick: Calling JS from Rust has a tiny overhead
            // Only trigger the callback every 10 scans (or on the very last scan) to keep it fast
            if completed_scans % 10 == 0 || completed_scans == total_scans {
                let percent = (completed_scans as f64 / total_scans as f64) * 100.0;
                // Call the JavaScript function
                let _ = progress_callback.call1(&JsValue::null(), &JsValue::from_f64(percent));
            }
        }
    }
    // Convert the Rust Structs to a JSON string to send back to JS
    serde_json::to_string(&results).unwrap()
}
