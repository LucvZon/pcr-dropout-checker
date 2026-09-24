use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use js_sys::Function;

#[derive(Serialize, Deserialize)]
pub struct MatchResult {
    pub sample_id: String,
    pub primer_id: String,
    pub is_forward: bool,
    pub mismatches: usize, // total edits subs+indels
    pub gaps: usize,
    pub cigar: String,
    pub start_pos: usize,
    pub end_pos: usize,
    pub sample_length: usize,
    pub status: String,
    pub alignment: String,
    pub mapped_primer_seq: String,
}

fn parse_fasta(fasta_str: &str) -> Vec<(String,String)> {
    let mut records=Vec::new(); let mut cur_id=String::new(); let mut cur_seq=String::new();
    for line in fasta_str.lines() {
        let line=line.trim(); if line.is_empty(){continue;}
        if line.starts_with('>') {
            if !cur_id.is_empty(){records.push((cur_id.clone(),cur_seq.clone()));cur_seq.clear();}
            cur_id=line[1..].to_string();
        } else {cur_seq.push_str(&line.to_uppercase());}
    }
    if !cur_id.is_empty(){records.push((cur_id,cur_seq));}
    records
}
fn reverse_complement(seq:&str)->String{
    seq.chars().rev().map(|c| match c {
        'A'=>'T','T'=>'A','U'=>'A','C'=>'G','G'=>'C','M'=>'K','K'=>'M',
        'R'=>'Y','Y'=>'R','W'=>'W','S'=>'S','B'=>'V','V'=>'B','D'=>'H','H'=>'D','N'=>'N','-'=>'-',
        _=>c,}).collect()
}
const fn build_iupac_table()->[u8;256]{
    let mut t=[0;256];
    t[b'A' as usize]=0b0001; t[b'C' as usize]=0b0010; t[b'G' as usize]=0b0100;
    t[b'T' as usize]=0b1000; t[b'U' as usize]=0b1000;
    t[b'R' as usize]=0b0101; t[b'Y' as usize]=0b1010; t[b'S' as usize]=0b0110;
    t[b'W' as usize]=0b1001; t[b'K' as usize]=0b1100; t[b'M' as usize]=0b0011;
    t[b'B' as usize]=0b1110; t[b'D' as usize]=0b1101; t[b'H' as usize]=0b1011;
    t[b'V' as usize]=0b0111; t[b'N' as usize]=0b1111; t[b'-' as usize]=0b10000;
    t
}
const IUPAC_TABLE:[u8;256]=build_iupac_table();
#[inline(always)]
fn is_iupac_match(p:u8,r:u8)->bool{
    if p==r{return true;} if r==b'N'{return false;}
    let mp=IUPAC_TABLE[p as usize]; let mr=IUPAC_TABLE[r as usize];
    if mp==0||mr==0{return false;} (mp&mr)!=0
}

// ---------- Peq ----------
enum PeqCache{ Single([u64;256]), Multi(Vec<Vec<u64>>,usize), }

fn build_peq_single(p:&[u8])->[u64;256]{
    let mut peq=[0u64;256];
    for (i,&pb) in p.iter().enumerate(){
        let bit=1u64<<i; let mp=IUPAC_TABLE[pb as usize];
        for c in 0..256{
            let cb=c as u8;
            let m=if pb==cb{true}else if cb==b'N'{false}else{
                let mr=IUPAC_TABLE[c]; mp!=0&&mr!=0&&(mp&mr)!=0};
            if m{peq[c]|=bit;}
        }
    } peq
}
fn build_peq_multi(p:&[u8])->(Vec<Vec<u64>>,usize){
    let nb=(p.len()+63)/64; let mut peq=vec![vec![0u64;nb];256];
    for (i,&pb) in p.iter().enumerate(){
        let b=i/64; let bit=1u64<<(i%64); let mp=IUPAC_TABLE[pb as usize];
        for c in 0..256{
            let cb=c as u8;
            let m=if pb==cb{true}else if cb==b'N'{false}else{
                let mr=IUPAC_TABLE[c]; mp!=0&&mr!=0&&(mp&mr)!=0};
            if m{peq[c][b]|=bit;}
        }
    } (peq,nb)
}
fn build_peq_cached(p:&[u8])->PeqCache{
    if p.len()<=64{PeqCache::Single(build_peq_single(p))}
    else{let (t,n)=build_peq_multi(p); PeqCache::Multi(t,n)}
}

// ---------- Myers substring ----------
fn myers_single(peq:&[u64;256], text:&[u8], m:usize)->(usize,Vec<usize>){
    let mut vp=!0u64; let mut vn=0u64;
    let mut score=m as i32; let mut best=i32::MAX;
    let mut cands=Vec::new(); let mask=1u64<<(m-1);
    for (j,&cb) in text.iter().enumerate(){
        let eq=peq[cb as usize];
        let x=eq|vn;
        let d0=((vp.wrapping_add(x&vp))^vp)|x;
        let hn=vp&d0; let hp=vn|!(vp|d0);
        let x2=hp<<1; // substring inject 0
        vn=x2&d0; vp=(hn<<1)|!(x2|d0);
        if (hp&mask)!=0{score+=1;}else if (hn&mask)!=0{score-=1;}
        if score<best{best=score;cands.clear();cands.push(j);if best==0{break;}}
        else if score==best&&best<=6&&cands.len()<50{cands.push(j);}
    }
    if cands.is_empty(){return (m,Vec::new());}
    (best as usize,cands)
}
fn myers_multi(peq:&[Vec<u64>], text:&[u8], m:usize, nb:usize)->(usize,Vec<usize>){
    let mut vp=vec![u64::MAX;nb]; let mut vn=vec![0u64;nb];
    let mut score=m as i32; let mut best=i32::MAX; let mut cands=Vec::new();
    let last=nb-1; let mask=1u64<<((m-1)%64);
    for (j,&cb) in text.iter().enumerate(){
        let mut c_add=0u64; let mut hp_c=0u64; let mut hn_c=0u64;
        let mut hp_l=0u64; let mut hn_l=0u64;
        for b in 0..nb{
            let eq=peq[cb as usize][b];
            let x=eq|vn[b]; let xv=x&vp[b];
            let sum=(vp[b] as u128)+(xv as u128)+(c_add as u128);
            let s64=sum as u64; c_add=(sum>>64) as u64;
            let d0=(s64^vp[b])|x;
            let hn=vp[b]&d0; let hp=vn[b]|!(vp[b]|d0);
            if b==last{hp_l=hp;hn_l=hn;}
            let hp_msb=(hp>>63)&1; let hn_msb=(hn>>63)&1;
            let xs=(hp<<1)|hp_c;
            vn[b]=xs&d0; vp[b]=((hn<<1)|hn_c)|!(xs|d0);
            hp_c=hp_msb; hn_c=hn_msb;
        }
        if (hp_l&mask)!=0{score+=1;}else if (hn_l&mask)!=0{score-=1;}
        if score<best{best=score;cands.clear();cands.push(j);if best==0{break;}}
        else if score==best&&best<=6&&cands.len()<50{cands.push(j);}
    }
    if cands.is_empty(){return (m,Vec::new());}
    (best as usize,cands)
}

// ---------- window traceback ----------
struct WAln{total:usize,subs:usize,gaps:usize,critical:usize,abs3:bool,
    start_in_win:usize, aln_str:String, aln_p:String, cigar:String,}

fn align_window(p:&[u8], win:&[u8], is_fwd:bool)->WAln{
    let m=p.len(); let w=win.len(); let st=w+1;
    let mut dp=vec![0u16;(m+1)*st];
    for i in 1..=m{dp[i*st]=i as u16;}
    for i in 1..=m{
        let pb=p[i-1]; let rb0=i*st; let pr=(i-1)*st;
        for j in 1..=w{
            let cost=if is_iupac_match(pb,win[j-1]){0}else{1};
            let d=dp[pr+j-1]+cost; let u=dp[pr+j]+1; let l=dp[rb0+j-1]+1;
            let mut b=d; if u<b{b=u;} if l<b{b=l;} dp[rb0+j]=b;
        }
    }
    let mut i=m; let mut j=w;
    let mut ap_r=Vec::with_capacity(m+4); let mut ar_r=Vec::with_capacity(m+4);
    let mut op_r=Vec::with_capacity(m+4); // 0=diag,1=I(gap ref),2=D(gap primer)
    while i>0{
        let cur=dp[i*st+j];
        let mut took=false;
        if j>0{
            let cost=if is_iupac_match(p[i-1],win[j-1]){0}else{1};
            if cur==dp[(i-1)*st+j-1]+cost{
                ap_r.push(p[i-1]); ar_r.push(win[j-1]); op_r.push(0u8); i-=1;j-=1;took=true;
            }
        }
        if took{continue;}
        if cur==dp[(i-1)*st+j]+1{
            ap_r.push(p[i-1]); ar_r.push(b'-'); op_r.push(1u8); i-=1; continue;
        }
        ap_r.push(b'-'); ar_r.push(win[j-1]); op_r.push(2u8); j-=1;
    }
    let start_in_win=j;
    ap_r.reverse(); ar_r.reverse(); op_r.reverse();
    let l=ap_r.len();
    let mut aln_str=String::with_capacity(l+l/4);
    let mut ops:Vec<(char,usize)>=Vec::new();
    let mut subs=0; let mut gaps=0;
    for k in 0..l{
        let op=op_r[k]; let qb=ap_r[k]; let rb=ar_r[k];
        let c:char;
        if op==2{ // D
            c='D'; gaps+=1; aln_str.push('['); aln_str.push(rb as char); aln_str.push(']');
        }else if op==1{ // I -> {-} non-consuming
            c='I'; gaps+=1; aln_str.push_str("{-}");
        }else if is_iupac_match(qb,rb){c='='; aln_str.push(rb as char);}
        else{c='X'; subs+=1; aln_str.push('['); aln_str.push(rb as char); aln_str.push(']');}
        if let Some(la)=ops.last_mut(){if la.0==c{la.1+=1;}else{ops.push((c,1));}}
        else{ops.push((c,1));}
    }
    let mut cigar=String::new();
    for (o,n) in ops{cigar.push_str(&n.to_string()); cigar.push(o);}
    // critical orientation-aware
    let mut crit=0; let mut abs3=false;
    if is_fwd{
        let mut pos=Vec::new();
        for (idx,&q) in ap_r.iter().enumerate().rev(){if op_r[idx]!=2{if q!=b'-'||op_r[idx]==0{
            // primer base exists if not D (D has q='-' gap). Diag with literal '-' still counts as primer base.
            // D is the only case with no primer base.
            pos.push(idx); if pos.len()==5{break;}
        }}}
        // Actually D has no primer base, I+diag have primer base (even if literal '-')
        // Above logic double counts; simplify: primer base exists iff op!=2
        // Recompute correctly:
        pos.clear();
        for idx in (0..l).rev(){if op_r[idx]!=2{pos.push(idx); if pos.len()==5{break;}}}
        if let Some(&lc)=pos.first(){
            if op_r[lc]==1||!is_iupac_match(ap_r[lc],ar_r[lc]){abs3=true;}
            // if op==1, ar='-' gap, mismatch
        }
        if !pos.is_empty(){
            let s=*pos.iter().min().unwrap();
            for c in s..l{
                if op_r[c]!=0{crit+=1;}
                else if !is_iupac_match(ap_r[c],ar_r[c]){crit+=1;}
            }
        }
    }else{
        let mut pos=Vec::new();
        for idx in 0..l{if op_r[idx]!=2{pos.push(idx); if pos.len()==5{break;}}}
        if let Some(&fc)=pos.first(){
            if op_r[fc]==1||!is_iupac_match(ap_r[fc],ar_r[fc]){abs3=true;}
        }
        if !pos.is_empty(){
            let e=*pos.iter().max().unwrap();
            for c in 0..=e{
                if op_r[c]!=0{crit+=1;}
                else if !is_iupac_match(ap_r[c],ar_r[c]){crit+=1;}
            }
        }
    }
    WAln{total:subs+gaps,subs,gaps,critical:crit,abs3,
        start_in_win, aln_str, aln_p:String::from_utf8(ap_r).unwrap(), cigar}
}

struct Best{total:usize,critical:usize,abs3:bool,start:usize,end:usize,
    aln:String,mapped:String,gaps:usize,cigar:String,}

fn find_best(p:&[u8],s:&[u8],peq:&PeqCache,bt:usize,bc:usize,is_fwd:bool)->Option<Best>{
    let m=p.len();
    let (bs,cands)=match peq{
        PeqCache::Single(q)=>myers_single(q,s,m),
        PeqCache::Multi(q,n)=>myers_multi(q,s,m,*n),
    };
    if cands.is_empty(){return None;}
    if bs>bt{return None;}
    let mut best_o:Option<Best>=None;
    for &e in &cands{
        let sw=e.saturating_sub(m+bs+5);
        let w=&s[sw..=e];
        let wa=align_window(p,w,is_fwd);
        let cur=Best{total:wa.total,critical:wa.critical,abs3:wa.abs3,
            start:sw+wa.start_in_win,end:e,aln:wa.aln_str,mapped:wa.aln_p,gaps:wa.gaps,cigar:wa.cigar};
        let better=match &best_o{
            None=>true,
            Some(b)=>cur.total<b.total||(cur.total==b.total&&cur.critical<b.critical)
                ||(cur.total==b.total&&cur.critical==b.critical&&cur.start<b.start),
        };
        if better{
            let brk=cur.total==bs&&cur.critical==0;
            best_o=Some(cur); if brk{break;}
        }
    }
    best_o.and_then(|b|{
        if b.total<bt||(b.total==bt&&b.critical<bc){Some(b)}else{None}
    })
}

#[wasm_bindgen]
pub fn scan_genomes(primers_fasta:&[u8],samples_fasta:&[u8],
    fwd_keyword:&str,rev_keyword:&str,auto_detect:bool,progress:&Function)->String{
    let ps=std::str::from_utf8(primers_fasta).expect("primers");
    let ss=std::str::from_utf8(samples_fasta).expect("samples");
    let primers=parse_fasta(ps); let samples=parse_fasta(ss);
    let mut res:Vec<MatchResult>=Vec::new();
    let total=primers.len()*samples.len(); let mut done=0;
    for (pid,pseq) in primers{
        let fwd=pseq.clone(); let rev=reverse_complement(&pseq);
        let fb=fwd.as_bytes(); let rb=rev.as_bytes(); let pl=fb.len();
        let is_f=pid.contains(fwd_keyword); let is_r=pid.contains(rev_keyword);
        let fq=if pl>0{Some(build_peq_cached(fb))}else{None};
        let rq=if pl>0{Some(build_peq_cached(rb))}else{None};
        for (sid,sseq) in &samples{
            let sb=sseq.as_bytes();
            if pl==0||sb.is_empty(){
                res.push(MatchResult{sample_id:sid.clone(),primer_id:pid.clone(),
                    is_forward:true,mismatches:99,gaps:0,cigar:String::new(),
                    start_pos:0,end_pos:0,sample_length:sb.len(),
                    status:if pl==0{"Invalid Primer"}else{"Not Found"}.to_string(),
                    alignment:String::new(),mapped_primer_seq:String::from_utf8(fb.to_vec()).unwrap_or_default()});
                done+=1; continue;
            }
            let (is_fwd,best)=if auto_detect{
                let f=find_best(fb,sb,fq.as_ref().unwrap(),usize::MAX,usize::MAX,true).unwrap();
                if f.total==0{(true,f)}
                else if let Some(r)=find_best(rb,sb,rq.as_ref().unwrap(),f.total,f.critical,false){(false,r)}
                else{(true,f)}
            }else{
                if is_r&&!is_f{(false,find_best(rb,sb,rq.as_ref().unwrap(),usize::MAX,usize::MAX,false).unwrap())}
                else{(true,find_best(fb,sb,fq.as_ref().unwrap(),usize::MAX,usize::MAX,true).unwrap())}
            };
            let st=if best.total==0{"Perfect"}
                else if best.abs3||best.critical>=2||best.total>5{"Failure"}
                else if best.critical==1||best.total>=4{"High Risk"}else{"Low Risk"};
            res.push(MatchResult{sample_id:sid.clone(),primer_id:pid.clone(),is_forward:is_fwd,
                mismatches:best.total,gaps:best.gaps,cigar:best.cigar,
                start_pos:best.start+1,end_pos:best.end+1,sample_length:sb.len(),
                status:st.to_string(),alignment:best.aln,mapped_primer_seq:best.mapped});
            done+=1;
            let iv=(total/200).max(1);
            if done%iv==0||done==total{
                let pc=(done as f64/total as f64)*100.0;
                let _=progress.call1(&JsValue::NULL,&JsValue::from_f64(pc));
            }
        }
    }
    serde_json::to_string(&res).unwrap()
}