use crate::workspace::{DirectoryIdentity, QualifiedDirectory, qualify_directory};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
    time::{Duration, Instant},
};
use windows_sys::Win32::Storage::FileSystem::*;

const LIMIT: usize = 180_000;
// Bound synchronous work below the private control timeout; slow system calls can still block.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const TIME_LIMIT: Duration = Duration::from_secs(5);
struct Budget {
    deadline: Instant,
    bytes: u64,
    max_file: u64,
    max_total: u64,
}
impl Budget {
    fn check(&self) -> Result<(), ()> {
        if Instant::now() >= self.deadline {
            Err(())
        } else {
            Ok(())
        }
    }
    fn reserve(&mut self, bytes: u64) -> Result<(), ()> {
        self.check()?;
        if bytes > self.max_file {
            return Err(());
        }
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .filter(|n| *n <= self.max_total)
            .ok_or(())?;
        Ok(())
    }
}
#[derive(Serialize)]
struct Entry {
    path: String,
    sha256: String,
}
#[derive(Serialize)]
pub struct Manifest {
    tracked: Vec<Entry>,
    untracked: Vec<Entry>,
    links: Vec<()>,
    excluded: Vec<String>,
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn hash(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
fn secret(rel: &str) -> bool {
    let lower = rel.to_lowercase();
    let mut parts = lower.split('/').collect::<Vec<_>>();
    let name = parts.pop().unwrap_or("");
    if parts.iter().any(|x| [".ssh", ".aws", ".gnupg"].contains(x)) {
        return true;
    }
    if [
        ".npmrc",
        ".netrc",
        "_netrc",
        ".pypirc",
        ".git-credentials",
        ".htpasswd",
    ]
    .contains(&name)
    {
        return true;
    }
    if name == ".env"
        || name.strip_prefix(".env.").is_some_and(|x| {
            !x.is_empty() && !["example", "sample", "template", "dist"].contains(&x)
        })
    {
        return true;
    }
    if [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk"]
        .iter()
        .any(|x| name.ends_with(x) && name.len() > x.len())
    {
        return true;
    }
    if name.contains("credentials") && name.ends_with(".json") {
        return true;
    }
    ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]
        .iter()
        .any(|x| name.starts_with(x) && !name.ends_with(".pub"))
}
fn walk(
    root: &Path,
    rel: &str,
    entries: &mut Vec<Entry>,
    excluded: &mut Vec<String>,
    size: &mut usize,
    locks: &mut (Vec<QualifiedDirectory>, Vec<File>),
    budget: &mut Budget,
) -> Result<(), ()> {
    budget.check()?;
    if rel.split('/').count() > 128 {
        return Err(());
    }
    let path = root.join(rel);
    let dir = qualify_directory(&path).map_err(|_| ())?;
    for item in fs::read_dir(dir.path()).map_err(|_| ())? {
        budget.check()?;
        let item = item.map_err(|_| ())?;
        let name = item.file_name().into_string().map_err(|_| ())?;
        crate::workspace::validate_basename(&name).map_err(|_| ())?;
        if name == ".git" {
            continue;
        }
        let relative = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        *size = size.checked_add(relative.len() + 130).ok_or(())?;
        if *size > LIMIT {
            return Err(());
        }
        if secret(&relative) {
            excluded.push(hash(relative.as_bytes()));
            continue;
        }
        let path = root.join(&relative);
        let meta = fs::symlink_metadata(&path).map_err(|_| ())?;
        if meta.file_type().is_symlink() {
            return Err(());
        }
        if meta.is_dir() {
            walk(root, &relative, entries, excluded, size, locks, budget)?;
            continue;
        }
        if !meta.is_file() {
            return Err(());
        }
        let mut file = File::options()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| ())?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
            || info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)
                != 0
            || info.nNumberOfLinks != 1
        {
            return Err(());
        }
        let file_size = (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow);
        budget.reserve(file_size)?;
        let mut digest = Sha256::new();
        let mut buf = [0u8; 65536];
        loop {
            budget.check()?;
            let n = file.read(&mut buf).map_err(|_| ())?;
            if n == 0 {
                break;
            }
            digest.update(&buf[..n]);
        }
        entries.push(Entry {
            path: relative,
            sha256: hex(&digest.finalize()),
        });
        locks.1.push(file);
    }
    dir.verify().map_err(|_| ())?;
    locks.0.push(dir);
    Ok(())
}
pub fn capture(path: &Path, identity: DirectoryIdentity) -> Result<Manifest, ()> {
    let mut budget = Budget {
        deadline: Instant::now() + TIME_LIMIT,
        bytes: 0,
        max_file: MAX_FILE_BYTES,
        max_total: MAX_TOTAL_BYTES,
    };
    capture_with_budget(path, identity, &mut budget)
}
fn capture_with_budget(
    path: &Path,
    identity: DirectoryIdentity,
    budget: &mut Budget,
) -> Result<Manifest, ()> {
    budget.check()?;
    let root = qualify_directory(path).map_err(|_| ())?;
    if root.identity() != identity {
        return Err(());
    }
    let mut tracked = Vec::new();
    let mut excluded = Vec::new();
    let mut size = 0;
    let mut locks = (Vec::new(), Vec::new());
    walk(
        root.path(),
        "",
        &mut tracked,
        &mut excluded,
        &mut size,
        &mut locks,
        budget,
    )?;
    budget.check()?;
    for dir in &locks.0 {
        dir.verify().map_err(|_| ())?;
    }
    tracked.sort_by(|a, b| a.path.cmp(&b.path));
    excluded.sort();
    root.verify().map_err(|_| ())?;
    budget.check()?;
    Ok(Manifest {
        tracked,
        untracked: vec![],
        links: vec![],
        excluded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secret_classification_and_inventory() {
        for name in [
            ".env",
            ".env.local",
            "a/credentials-test.json",
            ".ssh/config",
            "id_rsa",
            "x.pem",
        ] {
            assert!(secret(name), "{name}");
        }
        for name in [".env.example", "id_rsa.pub", "ordinary.txt"] {
            assert!(!secret(name), "{name}");
        }
        let root = std::env::temp_dir().join(format!(
            "splyce-inventory-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("ordinary.txt"), b"ordinary").unwrap();
        fs::write(root.join(".env"), b"secret fixture").unwrap();
        let qualified = qualify_directory(&root).unwrap();
        let manifest = capture(&root, qualified.identity()).unwrap();
        assert_eq!(manifest.tracked.len(), 1);
        assert_eq!(manifest.tracked[0].sha256, hash(b"ordinary"));
        assert_eq!(manifest.excluded, vec![hash(b".env")]);
        drop(qualified);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_link_and_hardlink_before_reading() {
        let root = std::env::temp_dir().join(format!(
            "splyce-inventory-link-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let outside = root.with_extension("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("marker"), b"outside").unwrap();
        let qualified = qualify_directory(&root).unwrap();
        let identity = qualified.identity();
        assert!(fs::rename(&root, root.with_extension("renamed")).is_err());
        drop(qualified);
        fs::hard_link(outside.join("marker"), root.join("hard")).unwrap();
        assert!(capture(&root, identity).is_err());
        fs::remove_file(root.join("hard")).unwrap();
        // A junction can be created without developer-mode symlink privileges.
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(root.join("link"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(capture(&root, identity).is_err());
        fs::remove_dir(root.join("link")).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[test]
    fn rejects_oversized_and_expired_without_retaining_locks() {
        let root = std::env::temp_dir().join(format!(
            "splyce-budget-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let file = File::create(root.join("large.bin")).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        drop(file);
        let qualified = qualify_directory(&root).unwrap();
        let identity = qualified.identity();
        drop(qualified);
        assert!(capture(&root, identity).is_err());
        fs::remove_file(root.join("large.bin")).unwrap();
        fs::write(root.join("one"), b"1234").unwrap();
        fs::write(root.join("two"), b"5678").unwrap();
        let mut budget = Budget {
            deadline: Instant::now() + TIME_LIMIT,
            bytes: 0,
            max_file: 4,
            max_total: 7,
        };
        assert!(capture_with_budget(&root, identity, &mut budget).is_err());
        let mut expired = Budget {
            deadline: Instant::now(),
            bytes: 0,
            max_file: MAX_FILE_BYTES,
            max_total: MAX_TOTAL_BYTES,
        };
        assert!(capture_with_budget(&root, identity, &mut expired).is_err());
        assert!(capture(&root, identity).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_verbatim_trailing_dot_secret_alias() {
        let root = std::env::temp_dir().join(format!(
            "splyce-alias-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join(".env"), b"fixture").unwrap();
        let alias = std::path::PathBuf::from(format!(r"\\?\{}\.env.", root.display()));
        fs::write(&alias, b"alias").unwrap();
        let qualified = qualify_directory(&root).unwrap();
        let identity = qualified.identity();
        drop(qualified);
        let result = capture(&root, identity);
        fs::remove_file(&alias).unwrap();
        fs::remove_dir_all(root).unwrap();
        assert!(result.is_err());
    }
}
