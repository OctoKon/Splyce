#![cfg(windows)]

#[path = "../src/workspace.rs"]
#[allow(dead_code)]
mod workspace;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use workspace::{WorkspaceError, create_child, qualify_directory, validate_basename};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "splyce-workspace-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove owned isolated fixture");
    }
}

#[test]
fn real_unicode_folder_alias_and_handle_pin() {
    let fixture = Fixture::new();
    let path = fixture.0.join("工作 space");
    fs::create_dir(&path).unwrap();
    let qualified = qualify_directory(&path).unwrap();
    let verbatim = PathBuf::from(format!("\\\\?\\{}", path.display()));
    let alias = qualify_directory(&verbatim).unwrap();
    assert_eq!(qualified.identity(), alias.identity());
    assert_eq!(qualified.path(), alias.path());
    qualified.verify().unwrap();
    assert!(fs::rename(&path, fixture.0.join("moved")).is_err());
    assert!(fs::remove_dir(&path).is_err());
    let old_identity = qualified.identity();
    drop(alias);
    drop(qualified);
    // Keep the old object alive under another name so its file ID cannot be reused.
    fs::rename(&path, fixture.0.join("old")).unwrap();
    fs::create_dir(&path).unwrap();
    assert_ne!(qualify_directory(&path).unwrap().identity(), old_identity);
}

#[test]
fn create_child_is_exclusive_and_keeps_parent_verified() {
    let fixture = Fixture::new();
    let parent = qualify_directory(&fixture.0).unwrap();
    let child = create_child(&parent, "新 workspace").unwrap();
    assert_eq!(child.path().parent(), Some(parent.path()));
    assert!(child.path().is_dir());
    assert!(matches!(
        create_child(&parent, "新 workspace"),
        Err(WorkspaceError::AlreadyExists)
    ));
    assert!(matches!(
        create_child(&parent, "新 WORKSPACE"),
        Err(WorkspaceError::AlreadyExists)
    ));
    parent.verify().unwrap();
    drop(child);
    drop(parent);
}

#[test]
fn rejects_unsafe_names_and_non_local_or_non_directory_paths() {
    let fixture = Fixture::new();
    let parent = qualify_directory(&fixture.0).unwrap();
    for name in [
        "", ".", "..", "a/b", "a\\b", "a:b", "x.", "x ", "a\n", "CON", "con.txt", "NUL", "COM1",
        "LPT9.txt", "COM¹", "CONIN$", "CONOUT$", "a?b",
    ] {
        assert_eq!(
            validate_basename(name),
            Err(WorkspaceError::InvalidName),
            "{name:?}"
        );
        assert!(matches!(
            create_child(&parent, name),
            Err(WorkspaceError::InvalidName)
        ));
    }
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    for path in [
        r"\\server\share",
        r"\\?\UNC\server\share",
        r"\\.\C:\",
        r"\\?\GLOBALROOT\Device",
        "relative",
        "C:relative",
    ] {
        assert!(qualify_directory(std::path::Path::new(path)).is_err());
    }
    let file = fixture.0.join("file");
    fs::write(&file, "test").unwrap();
    assert!(qualify_directory(&file).is_err());
    drop(parent);
}

#[test]
fn rejects_junction_and_descendant_escape() {
    let fixture = Fixture::new();
    let target = fixture.0.join("target");
    let link = fixture.0.join("junction");
    fs::create_dir(&target).unwrap();
    fs::create_dir(target.join("nested")).unwrap();
    // Junction creation normally requires no elevated privileges on NTFS.
    let status = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "isolated NTFS junction fixture unavailable"
    );
    assert!(qualify_directory(&link).is_err());
    assert!(qualify_directory(&link.join("nested")).is_err());
    fs::remove_dir(&link).unwrap();
}
