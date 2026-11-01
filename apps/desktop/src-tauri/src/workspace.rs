//! Native-selected local folders only. This leaf grants no engine authority.
//! Handle semantics: https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew
//! Chooser: https://learn.microsoft.com/windows/win32/api/shlobj_core/nf-shlobj_core-shbrowseforfolderw

use std::fs::{self, File, OpenOptions};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Component, Path, PathBuf, Prefix};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows_sys::Win32::System::WindowsProgramming::{DRIVE_FIXED, DRIVE_RAMDISK, DRIVE_REMOVABLE};
use windows_sys::Win32::UI::Shell::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceError {
    InvalidPath,
    Unavailable,
    IdentityChanged,
    InvalidName,
    AlreadyExists,
    CreationFailed,
    CreationUncertain,
    ChooserUnavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DirectoryIdentity {
    pub volume_serial: u32,
    pub file_id: u64,
}

// Deliberately no Debug/Serialize: canonical paths stay in the native boundary.
pub struct QualifiedDirectory {
    canonical_path: PathBuf,
    identity: DirectoryIdentity,
    // Pin every ancestor, excluding write/delete sharing, so path-based creation cannot
    // be redirected by renaming a parent after qualification.
    handles: Vec<File>,
}

impl QualifiedDirectory {
    pub fn path(&self) -> &Path {
        &self.canonical_path
    }
    pub fn identity(&self) -> DirectoryIdentity {
        self.identity
    }

    pub fn verify(&self) -> Result<(), WorkspaceError> {
        let reopened = qualify_directory(&self.canonical_path)?;
        if reopened.identity != self.identity
            || identity(self.handles.last().ok_or(WorkspaceError::Unavailable)?)? != self.identity
        {
            return Err(WorkspaceError::IdentityChanged);
        }
        Ok(())
    }
}

fn local_path(path: &Path) -> Result<PathBuf, WorkspaceError> {
    let mut components = path.components();
    let drive = match components.next() {
        Some(Component::Prefix(p)) => match p.kind() {
            Prefix::Disk(d) | Prefix::VerbatimDisk(d) if d.is_ascii_alphabetic() => d,
            _ => return Err(WorkspaceError::InvalidPath),
        },
        _ => return Err(WorkspaceError::InvalidPath),
    };
    if components.next() != Some(Component::RootDir) {
        return Err(WorkspaceError::InvalidPath);
    }
    let mut normalized = PathBuf::from(format!("{}:\\", drive as char));
    for part in components {
        match part {
            Component::Normal(name) => {
                // Refuse Win32 aliases which change meaning when removing a verbatim prefix.
                validate_basename(name.to_str().ok_or(WorkspaceError::InvalidPath)?)
                    .map_err(|_| WorkspaceError::InvalidPath)?;
                normalized.push(name);
            }
            _ => return Err(WorkspaceError::InvalidPath),
        }
    }
    let root: Vec<u16> = format!("{}:\\\0", drive as char).encode_utf16().collect();
    // Network drives (including mapped UNC shares) cannot be admitted.
    let kind = unsafe { GetDriveTypeW(root.as_ptr()) };
    if kind != DRIVE_FIXED && kind != DRIVE_REMOVABLE && kind != DRIVE_RAMDISK {
        return Err(WorkspaceError::InvalidPath);
    }
    Ok(normalized)
}

fn open_directory(path: &Path) -> Result<File, WorkspaceError> {
    // Metadata-only access does not enforce rename/delete sharing on Windows.
    let file = OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| WorkspaceError::Unavailable)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(WorkspaceError::Unavailable);
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(WorkspaceError::InvalidPath);
    }
    Ok(file)
}

fn identity(file: &File) -> Result<DirectoryIdentity, WorkspaceError> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(WorkspaceError::Unavailable);
    }
    Ok(DirectoryIdentity {
        volume_serial: info.dwVolumeSerialNumber,
        file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    })
}

fn final_path(file: &File) -> Result<PathBuf, WorkspaceError> {
    let mut buffer = vec![0u16; 32768];
    let size = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    } as usize;
    if size == 0 || size >= buffer.len() {
        return Err(WorkspaceError::Unavailable);
    }
    local_path(Path::new(&std::ffi::OsString::from_wide(&buffer[..size])))
}

/// Native callers only; never expose a renderer-supplied path command.
pub fn qualify_directory(path: &Path) -> Result<QualifiedDirectory, WorkspaceError> {
    let normalized = local_path(path)?;
    let mut current = PathBuf::new();
    let mut handles = Vec::new();
    for part in normalized.components() {
        current.push(part.as_os_str());
        if matches!(part, Component::RootDir | Component::Normal(_)) {
            handles.push(open_directory(&current)?);
        }
    }
    let last = handles.last().ok_or(WorkspaceError::InvalidPath)?;
    Ok(QualifiedDirectory {
        canonical_path: final_path(last)?,
        identity: identity(last)?,
        handles,
    })
}

pub fn validate_basename(name: &str) -> Result<(), WorkspaceError> {
    if name.is_empty()
        || name.encode_utf16().count() > 255
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err(WorkspaceError::InvalidName);
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    }) {
        return Err(WorkspaceError::InvalidName);
    }
    Ok(())
}

/// Caller MUST durably persist creation intent before calling. An uncertain
/// result means a child may exist: persist uncertainty; never delete or retry.
pub fn create_child(
    parent: &QualifiedDirectory,
    basename: &str,
) -> Result<QualifiedDirectory, WorkspaceError> {
    validate_basename(basename)?;
    parent.verify()?;
    let target = parent.path().join(basename);
    match fs::create_dir(&target) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(WorkspaceError::AlreadyExists);
        }
        Err(_) => return Err(WorkspaceError::CreationFailed),
    }
    let child = qualify_directory(&target).map_err(|_| WorkspaceError::CreationUncertain)?;
    parent
        .verify()
        .map_err(|_| WorkspaceError::CreationUncertain)?;
    if child.path().parent() != Some(parent.path()) {
        return Err(WorkspaceError::CreationUncertain);
    }
    Ok(child)
}

/// Call on the native UI thread with the real owning window, never renderer data.
/// Selection is neither Store admission nor a session capability grant.
pub fn choose_directory(parent: HWND) -> Result<Option<QualifiedDirectory>, WorkspaceError> {
    if parent.is_null() {
        return Err(WorkspaceError::ChooserUnavailable);
    }
    let hr = unsafe {
        CoInitializeEx(
            std::ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };
    if hr < 0 {
        return Err(WorkspaceError::ChooserUnavailable);
    }
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let _com = Com;
    let title: Vec<u16> = "Select workspace folder\0".encode_utf16().collect();
    let options = BROWSEINFOW {
        hwndOwner: parent,
        lpszTitle: title.as_ptr(),
        ulFlags: BIF_RETURNONLYFSDIRS
            | BIF_NEWDIALOGSTYLE
            | BIF_NONEWFOLDERBUTTON
            | BIF_NOTRANSLATETARGETS,
        ..Default::default()
    };
    let item = unsafe { SHBrowseForFolderW(&options) };
    if item.is_null() {
        return Ok(None);
    }
    let mut path = vec![0u16; 32768];
    let ok = unsafe {
        SHGetPathFromIDListEx(item, path.as_mut_ptr(), path.len() as u32, GPFIDL_DEFAULT)
    };
    unsafe { CoTaskMemFree(item.cast()) };
    if ok == 0 {
        return Err(WorkspaceError::InvalidPath);
    }
    let len = path
        .iter()
        .position(|&c| c == 0)
        .ok_or(WorkspaceError::InvalidPath)?;
    qualify_directory(Path::new(&std::ffi::OsString::from_wide(&path[..len]))).map(Some)
}
