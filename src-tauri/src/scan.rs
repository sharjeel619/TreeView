//! Parallel directory scanner. Windows-only: uses GetFileInformationByHandleEx(FileFullDirectoryInfo),
//! which returns name + size + *allocated* size + mtime for a whole batch of entries per syscall.
use rayon::prelude::*;
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::Mutex;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Storage::FileSystem::*;

pub struct File {
    pub name: Box<str>,
    pub size: u64,
    pub alloc: u64,
    pub mtime: u64,
}

#[derive(Default)]
pub struct Dir {
    pub name: Box<str>,
    pub size: u64,
    pub alloc: u64,
    pub files: u64, // recursive
    pub dirs: u64,  // recursive
    pub mtime: u64, // FILETIME, newest of self + descendants
    pub denied: bool,
    pub subs: Vec<Dir>,
    pub own: Vec<File>,
}

#[derive(Default)]
pub struct Ctx {
    pub cancel: AtomicBool,
    pub done: AtomicBool,
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    pub errors: AtomicU64,
    pub current: Mutex<String>,
}

const ATTR_DIR: u32 = 0x10;
const ATTR_REPARSE: u32 = 0x400;

pub fn wide(s: &std::path::Path) -> Vec<u16> {
    s.as_os_str().encode_wide().collect()
}

pub fn display(p: &[u16]) -> String {
    let s = String::from_utf16_lossy(p);
    if let Some(r) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{r}")
    } else {
        s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(s)
    }
}

/// Calls `f(attrs, size, alloc, mtime, name)` for every entry except `.` / `..`.
fn enumerate(path: &[u16], mut f: impl FnMut(u32, u64, u64, u64, &[u16])) -> Result<(), ()> {
    let mut z = path.to_vec();
    z.push(0);
    unsafe {
        let h = CreateFileW(
            z.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        );
        if h == INVALID_HANDLE_VALUE {
            return Err(());
        }
        let mut buf = vec![0u64; 64 * 1024 / 8]; // 64 KB, 8-byte aligned (max for SMB shares)
        let mut res = Ok(());
        loop {
            let ok = GetFileInformationByHandleEx(h, FileFullDirectoryInfo, buf.as_mut_ptr().cast(), (buf.len() * 8) as u32);
            if ok == 0 {
                if GetLastError() != ERROR_NO_MORE_FILES {
                    res = Err(());
                }
                break;
            }
            let base = buf.as_ptr() as *const u8;
            let mut off = 0usize;
            loop {
                let e = &*(base.add(off) as *const FILE_FULL_DIR_INFO);
                let name = std::slice::from_raw_parts(e.FileName.as_ptr(), e.FileNameLength as usize / 2);
                let dots = name == [46] || name == [46, 46];
                if !dots {
                    f(e.FileAttributes, e.EndOfFile as u64, e.AllocationSize as u64, e.LastWriteTime as u64, name);
                }
                if e.NextEntryOffset == 0 {
                    break;
                }
                off += e.NextEntryOffset as usize;
            }
        }
        CloseHandle(h);
        res
    }
}

fn scan_dir(path: Vec<u16>, name: Box<str>, mtime: u64, ctx: &Ctx) -> Dir {
    let mut d = Dir { name, mtime, ..Default::default() };
    if ctx.cancel.load(Relaxed) {
        return d;
    }
    let n = ctx.dirs.fetch_add(1, Relaxed);
    if n & 63 == 0 {
        if let Ok(mut c) = ctx.current.try_lock() {
            *c = display(&path);
        }
    }
    let mut subs: Vec<(Vec<u16>, Box<str>, u64)> = Vec::new();
    let r = enumerate(&path, |attr, size, alloc, mt, wname| {
        let nm: Box<str> = String::from_utf16_lossy(wname).into();
        if attr & ATTR_DIR != 0 {
            // Junctions/symlinked dirs are not followed (avoids loops & double counting).
            if attr & ATTR_REPARSE == 0 {
                let mut p = path.clone();
                if p.last() != Some(&92) {
                    p.push(92); // '\'
                }
                p.extend_from_slice(wname);
                subs.push((p, nm, mt));
            }
        } else {
            // ponytail: NTFS-resident files (data stored inside the MFT record) report an 8-byte-aligned
            // AllocationSize; real clusters are always 512-multiples, so anything else occupies no clusters.
            let alloc = if alloc % 512 == 0 { alloc } else { 0 };
            d.own.push(File { name: nm, size, alloc, mtime: mt });
        }
    });
    if r.is_err() {
        d.denied = true;
        ctx.errors.fetch_add(1, Relaxed);
    }
    let (fs, fa) = d.own.iter().fold((0, 0), |(s, a), f| (s + f.size, a + f.alloc));
    ctx.files.fetch_add(d.own.len() as u64, Relaxed);
    ctx.bytes.fetch_add(fs, Relaxed);

    d.subs = subs.into_par_iter().map(|(p, n, m)| scan_dir(p, n, m, ctx)).collect();

    d.size = fs + d.subs.iter().map(|s| s.size).sum::<u64>();
    d.alloc = fa + d.subs.iter().map(|s| s.alloc).sum::<u64>();
    d.files = d.own.len() as u64 + d.subs.iter().map(|s| s.files).sum::<u64>();
    d.dirs = d.subs.len() as u64 + d.subs.iter().map(|s| s.dirs).sum::<u64>();
    let newest = d.own.iter().map(|f| f.mtime).chain(d.subs.iter().map(|s| s.mtime)).max().unwrap_or(0);
    d.mtime = d.mtime.max(newest);
    d.subs.sort_unstable_by(|a, b| b.size.cmp(&a.size));
    d.own.sort_unstable_by(|a, b| b.size.cmp(&a.size));
    d
}

/// Scans `root` (an already-canonical `\\?\` path) using an oversubscribed pool:
/// the work is I/O-bound, so 2x logical cores keeps NVMe queues deep.
pub fn scan(root: Vec<u16>, name: String, ctx: &Ctx) -> Dir {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8) * 2;
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).stack_size(16 << 20).build().unwrap();
    pool.install(|| scan_dir(root, name.into(), 0, ctx))
}

pub fn filetime_ms(ft: u64) -> u64 {
    (ft / 10_000).saturating_sub(11_644_473_600_000)
}

// ---------- volumes ----------

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub root: String,
    pub label: String,
    pub fs: String,
    pub total: u64,
    pub free: u64,
    pub cluster: u64,
    pub kind: u32,
}

fn z(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

fn from_buf(b: &[u16]) -> String {
    String::from_utf16_lossy(&b[..b.iter().position(|&c| c == 0).unwrap_or(b.len())])
}

/// Info for the volume containing `path` (plain or `\\?\` form).
pub fn volume(path: &str) -> Option<Volume> {
    unsafe {
        let mut root = [0u16; 512];
        if GetVolumePathNameW(z(path).as_ptr(), root.as_mut_ptr(), root.len() as u32) == 0 {
            return None;
        }
        let root = from_buf(&root);
        let rz = z(&root);
        let (mut label, mut fs) = ([0u16; 261], [0u16; 261]);
        let (mut serial, mut maxlen, mut flags) = (0, 0, 0);
        if GetVolumeInformationW(rz.as_ptr(), label.as_mut_ptr(), 261, &mut serial, &mut maxlen, &mut flags, fs.as_mut_ptr(), 261) == 0 {
            return None;
        }
        let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
        GetDiskFreeSpaceExW(rz.as_ptr(), &mut avail, &mut total, &mut free);
        let (mut spc, mut bps, mut fc, mut tc) = (0u32, 0u32, 0u32, 0u32);
        GetDiskFreeSpaceW(rz.as_ptr(), &mut spc, &mut bps, &mut fc, &mut tc);
        Some(Volume {
            root: display(&root.encode_utf16().collect::<Vec<_>>()),
            label: from_buf(&label),
            fs: from_buf(&fs),
            total,
            free,
            cluster: spc as u64 * bps as u64,
            kind: GetDriveTypeW(rz.as_ptr()),
        })
    }
}

pub fn drives() -> Vec<Volume> {
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .filter_map(|i| volume(&format!("{}:\\", (b'A' + i) as char)))
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn scans_known_tree() {
        let root = std::env::temp_dir().join(format!("treeview-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::create_dir_all(root.join("c")).unwrap();
        std::fs::write(root.join("top.bin"), vec![0u8; 10]).unwrap();
        std::fs::write(root.join("a/x.bin"), vec![0u8; 5000]).unwrap();
        std::fs::write(root.join("a/b/y.bin"), vec![0u8; 100_000]).unwrap();
        // A junction back to root must not be followed (would loop forever otherwise).
        std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(root.join("c/loop")).arg(&root).output().unwrap();

        let canon = std::fs::canonicalize(&root).unwrap();
        let d = super::scan(super::wide(&canon), "t".into(), &super::Ctx::default());
        std::fs::remove_dir_all(&root).unwrap();

        assert_eq!(d.size, 105_010);
        assert_eq!(d.files, 3);
        assert_eq!(d.dirs, 3); // a, a/b, c
        assert_eq!(d.subs[0].name.as_ref(), "a"); // sorted by size desc
        assert_eq!(d.subs[0].subs[0].size, 100_000);
        assert!(d.alloc >= 100_000 && !d.denied);
    }
}
