use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};

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
    pub status: String, // "Perfect", "Warning (1-4)", "Not Found"
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

// Reverse Complement for the Reverse Primers
fn reverse_complement(seq: &str) -> String {
    seq.chars().rev().map(|c| match c {
        'A' => 'T',
        'T' => 'A',
        'C' => 'G',
        'G' => 'C',
        _ => c, // Keep N's or other ambiguous bases as is
    }).collect()
}

// Basic Levenshtein distance (calculates mismatches/indels between two strings of similar length)
fn levenshtein(a: &[u8], b: &[u8]) -> usize {
    let mut d = vec![0; b.len() + 1];
    for j in 0..=b.len() { d[j] = j; }
    for (i, &ca) in a.iter().enumerate() {
        let mut d_prev = i + 1;
        for (j, &cb) in b.iter().enumerate() {
            let d_curr = if ca == cb {
                d[j]
            } else {
                let min = d_prev.min(d[j]).min(d[j + 1]);
                min + 1
            };
            d[j] = d_prev;
            d_prev = d_curr;
        }
        d[b.len()] = d_prev;
    }
    d[b.len()]
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
) -> String {
    
    let primers = parse_fasta(primers_fasta);
    let samples = parse_fasta(samples_fasta);
    let mut results: Vec<MatchResult> = Vec::new();

    // Process Primers
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

        // Scan all samples for this primer
        for (s_id, s_seq) in &samples {
            let s_bytes = s_seq.as_bytes();
            
            // SAFETY CHECK 1: Is the primer empty?
            if p_len == 0 {
                results.push(MatchResult {
                    sample_id: s_id.clone(),
                    primer_id: p_id.clone(),
                    is_forward: !is_reverse || is_forward,
                    mismatches: 99,
                    start_pos: 0, end_pos: 0, status: "Invalid Primer".to_string(),
                });
                continue;
            }

            // SAFETY CHECK 2: Is the sample empty, or smaller than the primer?
            if s_bytes.len() < p_len {
                results.push(MatchResult {
                    sample_id: s_id.clone(),
                    primer_id: p_id.clone(),
                    is_forward: !is_reverse || is_forward,
                    mismatches: 99,
                    start_pos: 0, end_pos: 0, status: "Not Found (Sample too short)".to_string(),
                });
                continue;
            }
            
            let mut best_mismatches = usize::MAX;
            let mut best_index = 0;

            // Slide the primer across the genome. 
            // We pad the window slightly to allow for insertions/deletions.
            if s_bytes.len() >= p_len {
                for i in 0..=(s_bytes.len() - p_len) {
                    let window = &s_bytes[i..(i + p_len)];
                    let dist = levenshtein(p_bytes, window);
                    
                    if dist < best_mismatches {
                        best_mismatches = dist;
                        best_index = i;
                    }
                    // Optimization: If we find a perfect match, stop sliding!
                    if best_mismatches == 0 { break; }
                }
            }

            // Determine Status based on your rule (>4 = Not Found)
            let status = if best_mismatches == 0 {
                "Perfect"
            } else if best_mismatches <= 4 {
                "Warning"
            } else {
                "Not Found"
            };
            
            // If it's not found, coordinates are 0. Otherwise, 1-based coords.
            let (start, end) = if best_mismatches > 4 {
                (0, 0)
            } else {
                (best_index + 1, best_index + p_len)
            };

            results.push(MatchResult {
                sample_id: s_id.clone(),
                primer_id: p_id.clone(),
                is_forward: !is_reverse || is_forward,
                mismatches: if best_mismatches > 4 { 99 } else { best_mismatches },
                start_pos: start,
                end_pos: end,
                status: status.to_string(),
            });
        }
    }

    // Convert the Rust Structs to a JSON string to send back to JS
    serde_json::to_string(&results).unwrap()
}
