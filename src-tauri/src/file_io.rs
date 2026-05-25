use serde::{Deserialize, Serialize};
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
}
