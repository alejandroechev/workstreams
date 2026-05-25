use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum FsError {
    NotFound,
    PermissionDenied,
    IsADirectory,
    DiskFull,
    Io(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileMeta {
    pub size_bytes: u64,
    pub mtime_unix_ms: i64,
}

pub trait FileSystemProvider: Send + Sync {
    fn read(&self, path: &Path) -> Result<Vec<u8>, FsError>;
    fn write_atomic(&self, path: &Path, content: &[u8]) -> Result<(), FsError>;
    fn metadata(&self, path: &Path) -> Result<FileMeta, FsError>;
    fn canonicalize(&self, path: &Path) -> Result<PathBuf, FsError>;
    fn exists(&self, path: &Path) -> bool;
    fn is_dir(&self, path: &Path) -> bool;
}

const MAX_TEXT_FILE_BYTES: u64 = 1_048_576;
const BINARY_SNIFF_BYTES: usize = 4_096;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReadTextFileResult {
    pub content: String,
    pub mtime_unix_ms: i64,
    pub hash_hex: String,
    pub line_ending: String,
    pub has_trailing_newline: bool,
    pub sniffed_binary: bool,
    pub size_bytes: u64,
}

pub struct OsFileSystemProvider;

impl FileSystemProvider for OsFileSystemProvider {
    fn read(&self, path: &Path) -> Result<Vec<u8>, FsError> {
        if path.is_dir() {
            return Err(FsError::IsADirectory);
        }
        std::fs::read(path).map_err(map_io_error)
    }

    fn write_atomic(&self, path: &Path, content: &[u8]) -> Result<(), FsError> {
        if path.is_dir() {
            return Err(FsError::IsADirectory);
        }
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                return Err(FsError::NotFound);
            }
        }

        let tmp_path = temp_path_for(path);
        std::fs::write(&tmp_path, content).map_err(map_io_error)?;
        match std::fs::rename(&tmp_path, path) {
            Ok(()) => Ok(()),
            Err(err) if is_crosses_devices(&err) => {
                std::fs::copy(&tmp_path, path).map_err(map_io_error)?;
                std::fs::remove_file(&tmp_path).map_err(map_io_error)?;
                Ok(())
            }
            Err(err) => {
                let _ = std::fs::remove_file(&tmp_path);
                Err(map_io_error(err))
            }
        }
    }

    fn metadata(&self, path: &Path) -> Result<FileMeta, FsError> {
        let metadata = std::fs::metadata(path).map_err(map_io_error)?;
        Ok(FileMeta {
            size_bytes: metadata.len(),
            mtime_unix_ms: system_time_to_unix_ms(metadata.modified().map_err(map_io_error)?),
        })
    }

    fn canonicalize(&self, path: &Path) -> Result<PathBuf, FsError> {
        dunce::canonicalize(path).map_err(map_io_error)
    }

    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }
}

fn map_io_error(error: std::io::Error) -> FsError {
    match error.kind() {
        std::io::ErrorKind::NotFound => FsError::NotFound,
        std::io::ErrorKind::PermissionDenied => FsError::PermissionDenied,
        std::io::ErrorKind::WriteZero => FsError::DiskFull,
        _ => FsError::Io(error.to_string()),
    }
}

fn temp_path_for(path: &Path) -> PathBuf {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let suffix = &suffix[..8];
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    path.with_file_name(format!("{file_name}.tmp.{suffix}"))
}

fn is_crosses_devices(error: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        error.raw_os_error() == Some(17)
    }
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(18)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = error;
        false
    }
}

fn system_time_to_unix_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<ReadTextFileResult, String> {
    read_text_file_with(&OsFileSystemProvider, Path::new(&path))
}

pub fn read_text_file_with(
    provider: &dyn FileSystemProvider,
    path: &Path,
) -> Result<ReadTextFileResult, String> {
    let meta = provider.metadata(path).map_err(fs_error_to_string)?;
    if meta.size_bytes > MAX_TEXT_FILE_BYTES {
        return Err("too_large".to_string());
    }

    let bytes = provider.read(path).map_err(fs_error_to_string)?;
    let hash_hex = hash_bytes_hex(&bytes);
    let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
    let sniff = &bytes[..sniff_len];
    let sniffed_binary = sniff.contains(&0) || std::str::from_utf8(sniff).is_err();
    if sniffed_binary {
        return Ok(ReadTextFileResult {
            content: String::new(),
            mtime_unix_ms: meta.mtime_unix_ms,
            hash_hex,
            line_ending: "lf".to_string(),
            has_trailing_newline: false,
            sniffed_binary: true,
            size_bytes: meta.size_bytes,
        });
    }

    let content = String::from_utf8(bytes).map_err(|_| "binary".to_string())?;
    let line_ending = detect_line_ending(&content);
    let has_trailing_newline = content.ends_with('\n');

    Ok(ReadTextFileResult {
        content,
        mtime_unix_ms: meta.mtime_unix_ms,
        hash_hex,
        line_ending,
        has_trailing_newline,
        sniffed_binary: false,
        size_bytes: meta.size_bytes,
    })
}

fn fs_error_to_string(error: FsError) -> String {
    match error {
        FsError::NotFound => "not_found".to_string(),
        FsError::PermissionDenied => "permission_denied".to_string(),
        FsError::IsADirectory => "is_directory".to_string(),
        FsError::DiskFull => "disk_full".to_string(),
        FsError::Io(message) => message,
    }
}

fn hash_bytes_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

fn detect_line_ending(content: &str) -> String {
    let bytes = content.as_bytes();
    let mut crlf_count = 0;
    let mut lone_lf_count = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
            crlf_count += 1;
            i += 2;
        } else {
            if bytes[i] == b'\n' {
                lone_lf_count += 1;
            }
            i += 1;
        }
    }

    if crlf_count > 0 && lone_lf_count > 0 {
        "mixed".to_string()
    } else if crlf_count > 0 {
        "crlf".to_string()
    } else {
        "lf".to_string()
    }
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InMemoryErrorMode {
    PermissionDenied,
    DiskFull,
}

#[cfg(test)]
pub struct InMemoryFileSystemProvider {
    files: std::sync::Mutex<std::collections::HashMap<PathBuf, (Vec<u8>, i64)>>,
    directories: std::sync::Mutex<std::collections::HashSet<PathBuf>>,
    error_mode: std::sync::Mutex<Option<InMemoryErrorMode>>,
    clock_ms: std::sync::Mutex<i64>,
}

#[cfg(test)]
impl InMemoryFileSystemProvider {
    pub fn new() -> Self {
        Self {
            files: std::sync::Mutex::new(std::collections::HashMap::new()),
            directories: std::sync::Mutex::new(std::collections::HashSet::new()),
            error_mode: std::sync::Mutex::new(None),
            clock_ms: std::sync::Mutex::new(1_700_000_000_000),
        }
    }

    pub fn set_error_mode(&self, mode: Option<InMemoryErrorMode>) {
        *self.error_mode.lock().unwrap() = mode;
    }

    pub fn add_dir(&self, path: PathBuf) {
        self.directories.lock().unwrap().insert(path);
    }

    fn next_mtime_ms(&self) -> i64 {
        let mut clock = self.clock_ms.lock().unwrap();
        *clock += 1;
        *clock
    }

    fn injected_error(&self) -> Option<FsError> {
        self.error_mode.lock().unwrap().as_ref().map(|mode| match mode {
            InMemoryErrorMode::PermissionDenied => FsError::PermissionDenied,
            InMemoryErrorMode::DiskFull => FsError::DiskFull,
        })
    }
}

#[cfg(test)]
impl Default for InMemoryFileSystemProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl FileSystemProvider for InMemoryFileSystemProvider {
    fn read(&self, path: &Path) -> Result<Vec<u8>, FsError> {
        if let Some(error) = self.injected_error() {
            return Err(error);
        }
        if self.is_dir(path) {
            return Err(FsError::IsADirectory);
        }
        self.files
            .lock()
            .unwrap()
            .get(path)
            .map(|(content, _)| content.clone())
            .ok_or(FsError::NotFound)
    }

    fn write_atomic(&self, path: &Path, content: &[u8]) -> Result<(), FsError> {
        if let Some(error) = self.injected_error() {
            return Err(error);
        }
        if self.is_dir(path) {
            return Err(FsError::IsADirectory);
        }
        let mtime = self.next_mtime_ms();
        self.files
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), (content.to_vec(), mtime));
        Ok(())
    }

    fn metadata(&self, path: &Path) -> Result<FileMeta, FsError> {
        if let Some(error) = self.injected_error() {
            return Err(error);
        }
        if self.is_dir(path) {
            return Err(FsError::IsADirectory);
        }
        self.files
            .lock()
            .unwrap()
            .get(path)
            .map(|(content, mtime)| FileMeta {
                size_bytes: content.len() as u64,
                mtime_unix_ms: *mtime,
            })
            .ok_or(FsError::NotFound)
    }

    fn canonicalize(&self, path: &Path) -> Result<PathBuf, FsError> {
        if !self.exists(path) {
            return Err(FsError::NotFound);
        }
        Ok(path.components().collect())
    }

    fn exists(&self, path: &Path) -> bool {
        self.files.lock().unwrap().contains_key(path) || self.directories.lock().unwrap().contains(path)
    }

    fn is_dir(&self, path: &Path) -> bool {
        self.directories.lock().unwrap().contains(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_provider_reads_and_writes_atomic_content() {
        let fs = InMemoryFileSystemProvider::new();
        let path = PathBuf::from("C:\\repo\\note.txt");
        fs.write_atomic(&path, b"hello").unwrap();
        assert_eq!(fs.read(&path).unwrap(), b"hello");
        assert!(fs.exists(&path));
    }

    #[test]
    fn in_memory_provider_simulates_permission_denied() {
        let fs = InMemoryFileSystemProvider::new();
        fs.set_error_mode(Some(InMemoryErrorMode::PermissionDenied));
        let path = PathBuf::from("C:\\repo\\note.txt");
        assert_eq!(fs.write_atomic(&path, b"hello"), Err(FsError::PermissionDenied));
    }

    #[test]
    fn in_memory_provider_simulates_disk_full() {
        let fs = InMemoryFileSystemProvider::new();
        fs.set_error_mode(Some(InMemoryErrorMode::DiskFull));
        let path = PathBuf::from("C:\\repo\\note.txt");
        assert_eq!(fs.write_atomic(&path, b"hello"), Err(FsError::DiskFull));
    }

    #[test]
    fn in_memory_provider_rejects_directory_reads() {
        let fs = InMemoryFileSystemProvider::new();
        let path = PathBuf::from("C:\\repo");
        fs.add_dir(path.clone());
        assert_eq!(fs.read(&path), Err(FsError::IsADirectory));
    }

    #[test]
    fn read_text_file_rejects_files_over_size_cap() {
        let fs = InMemoryFileSystemProvider::new();
        let path = PathBuf::from("C:\\repo\\large.txt");
        fs.write_atomic(&path, &vec![b'a'; (MAX_TEXT_FILE_BYTES + 1) as usize])
            .unwrap();
        assert_eq!(read_text_file_with(&fs, &path), Err("too_large".to_string()));
    }

    #[test]
    fn read_text_file_sniffs_null_bytes_as_binary() {
        let fs = InMemoryFileSystemProvider::new();
        let path = PathBuf::from("C:\\repo\\bin.dat");
        fs.write_atomic(&path, b"abc\0def").unwrap();
        let result = read_text_file_with(&fs, &path).unwrap();
        assert!(result.sniffed_binary);
        assert_eq!(result.content, "");
    }

    #[test]
    fn read_text_file_sniffs_invalid_utf8_as_binary() {
        let fs = InMemoryFileSystemProvider::new();
        let path = PathBuf::from("C:\\repo\\bin.dat");
        fs.write_atomic(&path, &[0xff, 0xfe, b'a']).unwrap();
        let result = read_text_file_with(&fs, &path).unwrap();
        assert!(result.sniffed_binary);
        assert_eq!(result.content, "");
    }

    #[test]
    fn read_text_file_detects_line_endings() {
        assert_eq!(detect_line_ending("a\nb\n"), "lf");
        assert_eq!(detect_line_ending("a\r\nb\r\n"), "crlf");
        assert_eq!(detect_line_ending("a\r\nb\n"), "mixed");
        assert_eq!(detect_line_ending(""), "lf");
    }

    #[test]
    fn read_text_file_reports_trailing_newline_and_stable_hash() {
        let fs = InMemoryFileSystemProvider::new();
        let path = PathBuf::from("C:\\repo\\note.txt");
        fs.write_atomic(&path, b"hello\n").unwrap();
        let result = read_text_file_with(&fs, &path).unwrap();
        assert!(result.has_trailing_newline);
        assert_eq!(result.hash_hex, hash_bytes_hex(b"hello\n"));
        assert_eq!(result.size_bytes, 6);
    }
}
