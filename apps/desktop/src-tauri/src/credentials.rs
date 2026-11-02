//! Current-user Windows credentials; callers own admission and reference persistence.
#![cfg(windows)]

use std::fmt;
use std::ptr::{null_mut, write_volatile};
use std::sync::atomic::{Ordering, compiler_fence};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_NO_SUCH_LOGON_SESSION, ERROR_NO_TOKEN, ERROR_NOT_FOUND, GetLastError,
};
use windows_sys::Win32::Security::Credentials::{
    CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW,
    CredDeleteW, CredEnumerateW, CredFree, CredReadW, CredWriteW,
};
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};

const REFERENCE_PREFIX: &str = "splyce-credential:v1:";
const TARGET_PREFIX: &str = "Splyce/credentials/v1/";
const ID_BYTES: usize = 32;
pub const MAX_SECRET_BYTES: usize = CRED_MAX_CREDENTIAL_BLOB_SIZE as usize;
pub const MAX_REDACTION_TEXT_BYTES: usize = 1024 * 1024;
const MAX_REDACTION_CREDENTIALS: usize = 128;
const REDACTED: &str = "[REDACTED:credential]";

#[derive(Clone, PartialEq, Eq)]
pub struct CredentialRef(String);

impl CredentialRef {
    pub fn parse(value: &str) -> Result<Self, CredentialError> {
        let id = value
            .strip_prefix(REFERENCE_PREFIX)
            .ok_or(CredentialError::InvalidReference)?;
        if id.len() != ID_BYTES * 2
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(CredentialError::InvalidReference);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn target(&self) -> Vec<u16> {
        TARGET_PREFIX
            .encode_utf16()
            .chain(self.0[REFERENCE_PREFIX.len()..].encode_utf16())
            .chain(Some(0))
            .collect()
    }
}

/// Explicitly borrowed secret bytes; intentionally neither Debug nor Serialize nor Clone.
pub struct SecretBuffer(Vec<u8>);

impl SecretBuffer {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn as_str(&self) -> &str {
        // Construction accepts only validated UTF-8 and there is no mutable access.
        std::str::from_utf8(&self.0).expect("Validated credential encoding")
    }
}

impl Drop for SecretBuffer {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialError {
    InvalidReference,
    InvalidSecret,
    NotFound,
    AccessDenied,
    Unavailable,
    PlatformFailure,
    CorruptCredential,
}

impl fmt::Display for CredentialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidReference => "Invalid credential reference",
            Self::InvalidSecret => "Invalid credential value",
            Self::NotFound => "Credential unavailable",
            Self::AccessDenied => "Credential access denied",
            Self::Unavailable => "Credential facility unavailable",
            Self::PlatformFailure => "Credential operation failed",
            Self::CorruptCredential => "Invalid stored credential",
        })
    }
}

impl std::error::Error for CredentialError {}

fn validate_secret(secret: &str) -> Result<(), CredentialError> {
    if secret.is_empty() || secret.len() > MAX_SECRET_BYTES || secret.chars().any(char::is_control)
    {
        return Err(CredentialError::InvalidSecret);
    }
    Ok(())
}

fn last_error() -> CredentialError {
    // Read immediately after the failed Windows call, before any other OS operation.
    match unsafe { GetLastError() } {
        ERROR_NOT_FOUND => CredentialError::NotFound,
        ERROR_ACCESS_DENIED => CredentialError::AccessDenied,
        ERROR_NO_SUCH_LOGON_SESSION | ERROR_NO_TOKEN => CredentialError::Unavailable,
        _ => CredentialError::PlatformFailure,
    }
}

/// Always creates a fresh reference; rotating callers retain the old reference until committed.
pub fn write_generated(secret: &str) -> Result<CredentialRef, CredentialError> {
    validate_secret(secret)?;
    let mut id = [0_u8; ID_BYTES];
    // Null algorithm with this flag selects Windows' system-preferred cryptographic RNG.
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            id.as_mut_ptr(),
            ID_BYTES as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(CredentialError::Unavailable);
    }
    let mut reference = String::with_capacity(REFERENCE_PREFIX.len() + ID_BYTES * 2);
    reference.push_str(REFERENCE_PREFIX);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in id {
        reference.push(HEX[(byte >> 4) as usize] as char);
        reference.push(HEX[(byte & 15) as usize] as char);
    }
    let reference = CredentialRef(reference);
    let mut target = reference.target();
    let mut secret = SecretBuffer(secret.as_bytes().to_vec());
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: secret.0.len() as u32,
        CredentialBlob: secret.0.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..CREDENTIALW::default()
    };
    // All referenced buffers remain alive through the synchronous call.
    if unsafe { CredWriteW(&credential, 0) } == 0 {
        return Err(last_error());
    }
    Ok(reference)
}

struct NativeCredential(*mut CREDENTIALW);

impl Drop for NativeCredential {
    fn drop(&mut self) {
        // CredReadW owns this allocation, including its nested blob, until CredFree.
        unsafe {
            let credential = &*self.0;
            if !credential.CredentialBlob.is_null()
                && credential.CredentialBlobSize as usize <= MAX_SECRET_BYTES
            {
                wipe(std::slice::from_raw_parts_mut(
                    credential.CredentialBlob,
                    credential.CredentialBlobSize as usize,
                ));
            }
            CredFree(self.0.cast());
        }
    }
}

pub fn read_owned(reference: &CredentialRef) -> Result<SecretBuffer, CredentialError> {
    let target = reference.target();
    let mut pointer = null_mut();
    // Windows returns a single allocation freed by NativeCredential on every exit path.
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) } == 0 {
        return Err(last_error());
    }
    if pointer.is_null() {
        return Err(CredentialError::CorruptCredential);
    }
    let native = NativeCredential(pointer);
    let credential = unsafe { &*native.0 };
    let length = credential.CredentialBlobSize as usize;
    if credential.Type != CRED_TYPE_GENERIC
        || credential.Persist != CRED_PERSIST_LOCAL_MACHINE
        || length == 0
        || length > MAX_SECRET_BYTES
        || credential.CredentialBlob.is_null()
    {
        return Err(CredentialError::CorruptCredential);
    }
    let bytes = unsafe { std::slice::from_raw_parts(credential.CredentialBlob, length) };
    let secret = std::str::from_utf8(bytes).map_err(|_| CredentialError::CorruptCredential)?;
    validate_secret(secret).map_err(|_| CredentialError::CorruptCredential)?;
    Ok(SecretBuffer(bytes.to_vec()))
}

pub fn delete_owned(reference: &CredentialRef) -> Result<(), CredentialError> {
    let target = reference.target();
    if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
        return Err(last_error());
    }
    Ok(())
}

fn wipe(bytes: &mut [u8]) {
    // Best effort for these owned buffers only; OS/caller/compiler copies may remain.
    for byte in bytes {
        unsafe { write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

struct NativeInventory {
    pointer: *mut *mut CREDENTIALW,
    count: u32,
}

impl Drop for NativeInventory {
    fn drop(&mut self) {
        if self.pointer.is_null() {
            return;
        }
        // WinCred owns the complete array and nested blobs in one allocation.
        unsafe {
            for index in 0..self.count as usize {
                let pointer = *self.pointer.add(index);
                if !pointer.is_null() {
                    let credential = &*pointer;
                    if !credential.CredentialBlob.is_null() {
                        wipe(std::slice::from_raw_parts_mut(
                            credential.CredentialBlob,
                            credential.CredentialBlobSize as usize,
                        ));
                    }
                }
            }
            CredFree(self.pointer.cast());
        }
    }
}

fn base64(bytes: &[u8], url: bool, padding: bool) -> String {
    let alphabet = if url {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    } else {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    };
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let bits = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        for index in 0..4 {
            if index < chunk.len() + 1 {
                output.push(alphabet[((bits >> (18 - index * 6)) & 63) as usize] as char);
            } else if padding {
                output.push('=');
            }
        }
    }
    output
}

fn secret_forms(secret: &str) -> Vec<SecretBuffer> {
    let bytes = secret.as_bytes();
    let mut forms = vec![SecretBuffer(bytes.to_vec())];
    for url in [false, true] {
        for padding in [false, true] {
            forms.push(SecretBuffer(base64(bytes, url, padding).into_bytes()));
        }
    }
    for uppercase in [false, true] {
        let alphabet = if uppercase {
            b"0123456789ABCDEF"
        } else {
            b"0123456789abcdef"
        };
        let mut hex = Vec::with_capacity(bytes.len() * 2);
        let mut url = Vec::with_capacity(bytes.len() * 3);
        let mut component = Vec::with_capacity(bytes.len() * 3);
        for byte in bytes {
            let pair = [
                alphabet[(byte >> 4) as usize],
                alphabet[(byte & 15) as usize],
            ];
            hex.extend_from_slice(&pair);
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(byte) {
                url.push(*byte);
            } else {
                url.push(b'%');
                url.extend_from_slice(&pair);
            }
            if byte.is_ascii_alphanumeric() || b"-_.~!'()*".contains(byte) {
                component.push(*byte);
            } else {
                component.push(b'%');
                component.extend_from_slice(&pair);
            }
        }
        forms.push(SecretBuffer(hex));
        forms.push(SecretBuffer(url));
        forms.push(SecretBuffer(component));
    }
    // JSON escaping is the canonical serializer form, without surrounding quotes.
    let mut escaped = Vec::with_capacity(bytes.len() * 6 + 2);
    serde_json::to_writer(&mut escaped, secret).expect("String serialization is infallible");
    escaped.remove(0);
    escaped.pop();
    forms.push(SecretBuffer(escaped));
    forms
}

/// Enumerates only the app's generated namespace; never returns inventory or locations.
pub fn redact_owned(text: &str) -> Result<(String, usize), CredentialError> {
    let unavailable = CredentialError::Unavailable;
    if text.len() > MAX_REDACTION_TEXT_BYTES {
        return Err(unavailable);
    }
    let filter: Vec<u16> = format!("{TARGET_PREFIX}*")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut inventory = NativeInventory {
        pointer: null_mut(),
        count: 0,
    };
    if unsafe {
        CredEnumerateW(
            filter.as_ptr(),
            0,
            &mut inventory.count,
            &mut inventory.pointer,
        )
    } == 0
    {
        return if last_error() == CredentialError::NotFound
            && inventory.count == 0
            && inventory.pointer.is_null()
        {
            Ok((text.to_owned(), 0))
        } else {
            Err(unavailable)
        };
    }
    if inventory.pointer.is_null() || inventory.count as usize > MAX_REDACTION_CREDENTIALS {
        return Err(unavailable);
    }
    let mut forms = Vec::new();
    let mut bytes = 0usize;
    for index in 0..inventory.count as usize {
        let pointer = unsafe { *inventory.pointer.add(index) };
        if pointer.is_null() {
            return Err(unavailable);
        }
        let credential = unsafe { &*pointer };
        if credential.TargetName.is_null() {
            return Err(unavailable);
        }
        let expected_length = TARGET_PREFIX.len() + ID_BYTES * 2;
        let mut target = Vec::with_capacity(expected_length);
        for offset in 0..=expected_length {
            let unit = unsafe { *credential.TargetName.add(offset) };
            if unit == 0 {
                break;
            }
            target.push(unit);
        }
        let target = String::from_utf16(&target).map_err(|_| unavailable)?;
        let id = target.strip_prefix(TARGET_PREFIX).ok_or(unavailable)?;
        if target.len() != expected_length
            || CredentialRef::parse(&format!("{REFERENCE_PREFIX}{id}")).is_err()
            || credential.Type != CRED_TYPE_GENERIC
            || credential.Persist != CRED_PERSIST_LOCAL_MACHINE
            || !(8..=MAX_SECRET_BYTES).contains(&(credential.CredentialBlobSize as usize))
            || credential.CredentialBlob.is_null()
        {
            return Err(unavailable);
        }
        let blob = unsafe {
            std::slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            )
        };
        let secret = std::str::from_utf8(blob).map_err(|_| unavailable)?;
        validate_secret(secret).map_err(|_| unavailable)?;
        for form in secret_forms(secret) {
            bytes = bytes.checked_add(form.0.len()).ok_or(unavailable)?;
            if bytes > MAX_REDACTION_TEXT_BYTES {
                return Err(unavailable);
            }
            forms.push(form);
        }
    }
    forms.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));
    forms.dedup_by(|a, b| a.0 == b.0);
    let mut output = String::new();
    let mut count = 0;
    let mut offset = 0;
    while offset < text.len() {
        let remaining = &text[offset..];
        if let Some(form) = forms
            .iter()
            .find(|form| remaining.as_bytes().starts_with(&form.0))
        {
            output.push_str(REDACTED);
            offset += form.0.len();
            count += 1;
        } else {
            let character = remaining.chars().next().expect("Nonempty remaining text");
            output.push(character);
            offset += character.len_utf8();
        }
        if output.len() > MAX_REDACTION_TEXT_BYTES {
            return Err(unavailable);
        }
    }
    // The fixed marker and adjacent text can themselves recreate an inventoried value.
    if forms.iter().any(|form| output.contains(form.as_str())) {
        return Err(unavailable);
    }
    Ok((output, count))
}
