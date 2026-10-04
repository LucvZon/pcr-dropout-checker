use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use js_sys::Function;

#[derive(Serialize, Deserialize)]
pub struct MatchResult {
    pub sample_id: String,
    pub primer_id: String,
    pub is_forward: bool,
    pub mismatches: usize,   // Total edits (subs+indels)
    pub gaps: usize,
    pub cigar: String,
    pub start_pos: usize,
    pub end_pos: usize,
    pub sample_length: usize,
    pub status: String,      // "Perfect", "Low Risk", "High Risk", "Failure"
    pub alignment: String,   // A visual string e.g. ".....X.." (X = mismatch)
    pub mapped_primer_seq: String,
}

// -----------------------------------------
// FASTA & IUPAC UTILITIES
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

// -----------------------------------------
// MYERS BIT-PARALLEL SUBSTRING ENGINE
// -----------------------------------------

enum PeqCache {
    Single([u64; 256]),
    Multi(Vec<Vec<u64>>, usize),
}

fn build_peq_single(p: &[u8]) -> [u64; 256] {
    let mut peq = [0u64; 256];
    for (i, &pb) in p.iter().enumerate() {
        let bit = 1u64 << i;
        let mp = IUPAC_TABLE[pb as usize];
        for c in 0..256 {
            let cb = c as u8;
            let m = if pb == cb {
                true
            } else if cb == b'N' {
                false
            } else {
                let mr = IUPAC_TABLE[c];
                mp != 0 && mr != 0 && (mp & mr) != 0
            };
            if m {
                peq[c] |= bit;
            }
        }
    }
    peq
}

fn build_peq_multi(p: &[u8]) -> (Vec<Vec<u64>>, usize) {
    let nb = (p.len() + 63) / 64;
    let mut peq = vec![vec![0u64; nb]; 256];
    for (i, &pb) in p.iter().enumerate() {
        let b = i / 64;
        let bit = 1u64 << (i % 64);
        let mp = IUPAC_TABLE[pb as usize];
        for c in 0..256 {
            let cb = c as u8;
            let m = if pb == cb {
                true
            } else if cb == b'N' {
                false
            } else {
                let mr = IUPAC_TABLE[c];
                mp != 0 && mr != 0 && (mp & mr) != 0
            };
            if m {
                peq[c][b] |= bit;
            }
        }
    }
    (peq, nb)
}

fn build_peq_cached(p: &[u8]) -> PeqCache {
    if p.len() <= 64 {
        PeqCache::Single(build_peq_single(p))
    } else {
        let (t, n) = build_peq_multi(p);
        PeqCache::Multi(t, n)
    }
}

// Myers substring
fn myers_single(peq: &[u64; 256], text: &[u8], m: usize) -> (usize, Vec<usize>) {
    let mut vp = !0u64;
    let mut vn = 0u64;
    let mut score = m as i32;
    let mut best = i32::MAX;
    let mut cands = Vec::new();
    let mask = 1u64 << (m - 1);

    for (j, &cb) in text.iter().enumerate() {
        let eq = peq[cb as usize];
        let x = eq | vn;
        let d0 = ((vp.wrapping_add(x & vp)) ^ vp) | x;
        let hn = vp & d0;
        let hp = vn | !(vp | d0);
        let x2 = hp << 1;
        vn = x2 & d0;
        vp = (hn << 1) | !(x2 | d0);
        if (hp & mask) != 0 {
            score += 1;
        } else if (hn & mask) != 0 {
            score -= 1;
        }

        if score < best {
            best = score;
            cands.clear();
            cands.push(j);
            if best == 0 {
                break;
            }
        } else if score == best && best <= 6 && cands.len() < 50 {
            // Guard: do not collect identical adjacent columns in homopolymer stretches
            if let Some(&last_j) = cands.last() {
                if j > last_j + 2 {
                    cands.push(j);
                }
            } else {
                cands.push(j);
            }
        }
    }
    if cands.is_empty() {
        return (m, Vec::new());
    }
    (best as usize, cands)
}

fn myers_multi(peq: &[Vec<u64>], text: &[u8], m: usize, nb: usize) -> (usize, Vec<usize>) {
    let mut vp = vec![u64::MAX; nb];
    let mut vn = vec![0u64; nb];
    let mut score = m as i32;
    let mut best = i32::MAX;
    let mut cands = Vec::new();
    let last = nb - 1;
    let mask = 1u64 << ((m - 1) % 64);

    for (j, &cb) in text.iter().enumerate() {
        let mut c_add = 0u64;
        let mut hp_c = 0u64;
        let mut hn_c = 0u64;
        let mut hp_l = 0u64;
        let mut hn_l = 0u64;

        for b in 0..nb {
            let eq = peq[cb as usize][b];
            let x = eq | vn[b];
            let xv = x & vp[b];
            let sum = (vp[b] as u128) + (xv as u128) + (c_add as u128);
            let s64 = sum as u64;
            c_add = (sum >> 64) as u64;
            let d0 = (s64 ^ vp[b]) | x;
            let hn = vp[b] & d0;
            let hp = vn[b] | !(vp[b] | d0);
            if b == last {
                hp_l = hp;
                hn_l = hn;
            }
            let hp_msb = (hp >> 63) & 1;
            let hn_msb = (hn >> 63) & 1;
            let xs = (hp << 1) | hp_c;
            vn[b] = xs & d0;
            vp[b] = ((hn << 1) | hn_c) | !(xs | d0);
            hp_c = hp_msb;
            hn_c = hn_msb;
        }

        if (hp_l & mask) != 0 {
            score += 1;
        } else if (hn_l & mask) != 0 {
            score -= 1;
        }

        if score < best {
            best = score;
            cands.clear();
            cands.push(j);
            if best == 0 {
                break;
            }
        } else if score == best && best <= 6 && cands.len() < 50 {
            if let Some(&last_j) = cands.last() {
                if j > last_j + 2 {
                    cands.push(j);
                }
            } else {
                cands.push(j);
            }
        }
    }
    if cands.is_empty() {
        return (m, Vec::new());
    }
    (best as usize, cands)
}

// -----------------------------------------
// LOCAL WINDOW TRACEBACK & 3' EVALUATION
// -----------------------------------------
struct WAln {
    total: usize,
    gaps: usize,
    critical: usize,
    abs3: bool,
    start_in_win: usize,
    end_in_win: usize,
    aln_str: String,
    aln_p: String,
    cigar: String,
}

fn align_window(p: &[u8], win: &[u8], is_fwd: bool, e_win: usize) -> WAln {
    let m = p.len();
    let w = win.len();
    let st = w + 1;
    let mut dp = vec![0u16; (m + 1) * st];

    for i in 1..=m {
        dp[i * st] = i as u16;
    }

    for i in 1..=m {
        let pb = p[i - 1];
        let rb0 = i * st;
        let pr = (i - 1) * st;
        for j in 1..=w {
            let cost = if is_iupac_match(pb, win[j - 1]) { 0 } else { 1 };
            let d = dp[pr + j - 1] + cost;
            let u = dp[pr + j] + 1;
            let l = dp[rb0 + j - 1] + 1;
            let mut b = d;
            if u < b { b = u; }
            if l < b { b = l; }
            dp[rb0 + j] = b;
        }
    }

    // Determine the optimal ending column in row m
    let search_start = e_win.saturating_sub(5).max(1);
    let search_end = (e_win + 5).min(w);

    let mut min_cost = u16::MAX;
    for j in search_start..=search_end {
        if dp[m * st + j] < min_cost {
            min_cost = dp[m * st + j];
        }
    }

    let mut best_j = e_win.min(w);
    let mut best_diag = false;
    let mut min_dist = usize::MAX;

    for j in search_start..=search_end {
        if dp[m * st + j] == min_cost {
            let cost = if is_iupac_match(p[m - 1], win[j - 1]) { 0 } else { 1 };
            let can_diag = dp[(m - 1) * st + j - 1] + cost == min_cost;
            let dist = if j >= e_win { j - e_win } else { e_win - j };

            // Prioritize diagonal alignment (substitution/match) over terminal insertion
            if can_diag && !best_diag {
                best_j = j;
                best_diag = true;
                min_dist = dist;
            } else if can_diag == best_diag {
                if dist < min_dist {
                    best_j = j;
                    min_dist = dist;
                }
            }
        }
    }

    let mut i = m;
    let mut j = best_j;
    let end_in_win = best_j;
    let mut ap_r = Vec::with_capacity(m + 4);
    let mut ar_r = Vec::with_capacity(m + 4);
    let mut op_r = Vec::with_capacity(m + 4); // 0=diag, 1=I(gap ref), 2=D(gap primer)

    while i > 0 {
        let cur = dp[i * st + j];
        let mut took = false;
        if j > 0 {
            let cost = if is_iupac_match(p[i - 1], win[j - 1]) { 0 } else { 1 };
            if cur == dp[(i - 1) * st + j - 1] + cost {
                ap_r.push(p[i - 1]);
                ar_r.push(win[j - 1]);
                op_r.push(0u8);
                i -= 1;
                j -= 1;
                took = true;
            }
        }
        if took { continue; }

        if cur == dp[(i - 1) * st + j] + 1 {
            ap_r.push(p[i - 1]);
            ar_r.push(b'-');
            op_r.push(1u8);
            i -= 1;
            continue;
        }

        if j > 0 {
            ap_r.push(b'-');
            ar_r.push(win[j - 1]);
            op_r.push(2u8);
            j -= 1;
        } else {
            i -= 1;
        }
    }
    let start_in_win = j;
    ap_r.reverse();
    ar_r.reverse();
    op_r.reverse();

    let l = ap_r.len();
    let mut aln_str = String::with_capacity(l + l / 4);
    let mut ops: Vec<(char, usize)> = Vec::new();
    let mut subs = 0;
    let mut gaps = 0;

    for k in 0..l {
        let op = op_r[k];
        let qb = ap_r[k];
        let rb = ar_r[k];
        let c: char;
        if op == 2 {
            c = 'D';
            gaps += 1;
            aln_str.push('[');
            aln_str.push('-');
            aln_str.push(']');
        } else if op == 1 {
            c = 'I';
            gaps += 1;
            aln_str.push('{');
            aln_str.push(qb as char);
            aln_str.push('}');
        } else if is_iupac_match(qb, rb) {
            c = '=';
            aln_str.push(qb as char);
        } else {
            c = 'X';
            subs += 1;
            aln_str.push('[');
            aln_str.push(qb as char);
            aln_str.push(']');
        }
        if let Some(la) = ops.last_mut() {
            if la.0 == c { la.1 += 1; } else { ops.push((c, 1)); }
        } else {
            ops.push((c, 1));
        }
    }

    let mut cigar = String::new();
    for (o, n) in ops {
        cigar.push_str(&n.to_string());
        cigar.push(o);
    }

    // 3' critical scoring with proper strand orientation
    let mut crit = 0;
    let mut abs3 = false;

    if is_fwd {
        let mut pos = Vec::new();
        for idx in (0..l).rev() {
            if op_r[idx] != 2 {
                pos.push(idx);
                if pos.len() == 5 { break; }
            }
        }
        if let Some(&lc) = pos.first() {
            if op_r[lc] == 1 || !is_iupac_match(ap_r[lc], ar_r[lc]) {
                abs3 = true;
            }
        }
        if !pos.is_empty() {
            let s = *pos.iter().min().unwrap();
            for c in s..l {
                if op_r[c] != 0 || !is_iupac_match(ap_r[c], ar_r[c]) {
                    crit += 1;
                }
            }
        }
    } else {
        // Reverse primer: 3' terminus is at index 0 of the reverse-complement sequence
        let mut pos = Vec::new();
        for idx in 0..l {
            if op_r[idx] != 2 {
                pos.push(idx);
                if pos.len() == 5 { break; }
            }
        }
        if let Some(&fc) = pos.first() {
            if op_r[fc] == 1 || !is_iupac_match(ap_r[fc], ar_r[fc]) {
                abs3 = true;
            }
        }
        if !pos.is_empty() {
            let e = *pos.iter().max().unwrap();
            for c in 0..=e {
                if op_r[c] != 0 || !is_iupac_match(ap_r[c], ar_r[c]) {
                    crit += 1;
                }
            }
        }
    }

    WAln {
        total: subs + gaps,
        gaps,
        critical: crit,
        abs3,
        start_in_win,
        end_in_win,
        aln_str,
        aln_p: String::from_utf8(ap_r).unwrap_or_default(),
        cigar,
    }
}

struct Best {
    total: usize,
    critical: usize,
    abs3: bool,
    start: usize,
    end: usize,
    aln: String,
    mapped: String,
    gaps: usize,
    cigar: String,
}

fn find_best(
    p: &[u8],
    s: &[u8],
    peq: &PeqCache,
    bt: usize,
    bc: usize,
    is_fwd: bool,
) -> Option<Best> {
    let m = p.len();
    let (bs, cands) = match peq {
        PeqCache::Single(q) => myers_single(q, s, m),
        PeqCache::Multi(q, n) => myers_multi(q, s, m, *n),
    };
    if cands.is_empty() { return None; }
    if bs > bt { return None; }

    let mut best_o: Option<Best> = None;
    for &e in &cands {
        if e >= s.len() { continue; }
        let sw = e.saturating_sub(m + bs + 5);
        let ew = (e + bs + 5).min(s.len().saturating_sub(1));
        if sw > ew { continue; }
        let w = &s[sw..=ew];
        let e_win = e - sw + 1;
        let wa = align_window(p, w, is_fwd, e_win);
        let cur = Best {
            total: wa.total,
            critical: wa.critical,
            abs3: wa.abs3,
            start: sw + wa.start_in_win,
            end: sw + wa.end_in_win - 1,
            aln: wa.aln_str,
            mapped: wa.aln_p,
            gaps: wa.gaps,
            cigar: wa.cigar,
        };
        let better = match &best_o {
            None => true,
            Some(b) => cur.total < b.total
                || (cur.total == b.total && cur.critical < b.critical)
                || (cur.total == b.total && cur.critical == b.critical && cur.start < b.start),
        };
        if better {
            let brk = cur.total == bs && cur.critical == 0;
            best_o = Some(cur);
            if brk { break; }
        }
    }
    best_o.and_then(|b| {
        if b.total < bt || (b.total == bt && b.critical < bc) {
            Some(b)
        } else {
            None
        }
    })
}

// -----------------------------------------
// ENTRY POINT
// -----------------------------------------
#[wasm_bindgen]
pub fn scan_genomes(
    primers_fasta: &[u8],
    samples_fasta: &[u8],
    fwd_keyword: &str,
    rev_keyword: &str,
    auto_detect: bool,
    progress: &Function,
) -> String {
    let ps = std::str::from_utf8(primers_fasta).expect("Invalid UTF-8 in primers");
    let ss = std::str::from_utf8(samples_fasta).expect("Invalid UTF-8 in samples");
    let primers = parse_fasta(ps);
    let samples = parse_fasta(ss);
    let mut res: Vec<MatchResult> = Vec::new();
    let total = primers.len() * samples.len();
    let mut done = 0;

    for (pid, pseq) in primers {
        let fwd = pseq.clone();
        let rev = reverse_complement(&pseq);
        let fb = fwd.as_bytes();
        let rb = rev.as_bytes();
        let pl = fb.len();
        let is_f = pid.contains(fwd_keyword);
        let is_r = pid.contains(rev_keyword);
        let fq = if pl > 0 { Some(build_peq_cached(fb)) } else { None };
        let rq = if pl > 0 { Some(build_peq_cached(rb)) } else { None };

        for (sid, sseq) in &samples {
            let sb = sseq.as_bytes();
            if pl == 0 || sb.len() < pl.saturating_sub(2) {
                res.push(MatchResult {
                    sample_id: sid.clone(),
                    primer_id: pid.clone(),
                    is_forward: true,
                    mismatches: 99,
                    gaps: 0,
                    cigar: String::new(),
                    start_pos: 0,
                    end_pos: 0,
                    sample_length: sb.len(),
                    status: if pl == 0 { "Invalid Primer" } else { "Not Found" }.to_string(),
                    alignment: String::new(),
                    mapped_primer_seq: String::from_utf8(fb.to_vec()).unwrap_or_default(),
                });
                done += 1;
                continue;
            }

            let (is_fwd, best) = if auto_detect {
                let f = find_best(fb, sb, fq.as_ref().unwrap(), usize::MAX, usize::MAX, true).unwrap();
                if f.total == 0 {
                    (true, f)
                } else if let Some(r) = find_best(rb, sb, rq.as_ref().unwrap(), f.total, f.critical, false) {
                    (false, r)
                } else {
                    (true, f)
                }
            } else {
                // Fallback to strict keywords
                if is_r && !is_f {
                    (false, find_best(rb, sb, rq.as_ref().unwrap(), usize::MAX, usize::MAX, false).unwrap())
                } else {
                    (true, find_best(fb, sb, fq.as_ref().unwrap(), usize::MAX, usize::MAX, true).unwrap())
                }
            };

            // Grading logic
            let st = if best.total == 0 {
                "Perfect"
            } else if best.abs3 || best.critical >= 2 || best.total > 5 || (best.gaps > 0 && (best.critical >= 1 || best.total >= 2)) {
                "Failure"
            } else if best.critical == 1 || best.total >= 4 || best.gaps > 0 {
                "High Risk"
            } else {
                "Low Risk"
            };

            res.push(MatchResult {
                sample_id: sid.clone(),
                primer_id: pid.clone(),
                is_forward: is_fwd,
                mismatches: best.total,
                gaps: best.gaps,
                cigar: best.cigar,
                start_pos: best.start + 1,
                end_pos: best.end + 1,
                sample_length: sb.len(),
                status: st.to_string(),
                alignment: best.aln,
                mapped_primer_seq: best.mapped,
            });

            done += 1;
            let iv = (total / 200).max(1);
            if done % iv == 0 || done == total {
                let pc = (done as f64 / total as f64) * 100.0;
                let _ = progress.call1(&JsValue::NULL, &JsValue::from_f64(pc));
            }
        }
    }
    serde_json::to_string(&res).unwrap()
}
