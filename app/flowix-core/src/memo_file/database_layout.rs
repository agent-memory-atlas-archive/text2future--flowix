//! User-level SQLite database layout helpers.
//!
//! Databases used to live directly under `~/.flowix/`. They now live under
//! `~/.flowix/db/`. Publish a complete SQLite snapshot under a layout lock;
//! interruption leaves the original database and its WAL together for retry.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::{error::Error, fmt};

use fs2::FileExt;

pub const DATABASE_DIRECTORY_NAME: &str = "db";

#[derive(Debug)]
struct DatabaseLayoutIoError {
    operation: String,
    source: io::Error,
}

impl fmt::Display for DatabaseLayoutIoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.operation, self.source)
    }
}

impl Error for DatabaseLayoutIoError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.source)
    }
}

fn with_io_context(error: io::Error, operation: impl Into<String>) -> io::Error {
    let kind = error.kind();
    io::Error::new(
        kind,
        DatabaseLayoutIoError {
            operation: operation.into(),
            source: error,
        },
    )
}

/// Create `db/` and snapshot existing named databases from the config root.
/// The source is retained with its sidecars. An existing canonical database
/// wins, leaving the complete legacy copy untouched.
pub fn prepare_database_directory(
    config_dir: &Path,
    database_names: &[&str],
) -> io::Result<PathBuf> {
    super::ensure_storage_directory(config_dir).map_err(|error| {
        with_io_context(
            error,
            format!("prepare configuration directory {}", config_dir.display()),
        )
    })?;
    let lock_path = config_dir.join(".database-layout.lock");
    if fs::symlink_metadata(&lock_path).is_ok_and(|metadata| !metadata.file_type().is_file()) {
        super::backup_storage_file(&lock_path).map_err(|error| {
            with_io_context(
                error,
                format!(
                    "preserve invalid database layout lock {}",
                    lock_path.display()
                ),
            )
        })?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| {
            with_io_context(
                error,
                format!("open database layout lock {}", lock_path.display()),
            )
        })?;
    FileExt::try_lock_exclusive(&lock).map_err(|error| {
        with_io_context(
            error,
            format!("acquire database layout lock {}", lock_path.display()),
        )
    })?;

    let result = (|| {
        let database_dir = config_dir.join(DATABASE_DIRECTORY_NAME);
        super::ensure_storage_directory(&database_dir).map_err(|error| {
            with_io_context(
                error,
                format!("prepare database directory {}", database_dir.display()),
            )
        })?;
        for name in database_names {
            validate_database_name(name)?;
            move_database_with_sidecars(config_dir, &database_dir, name)?;
        }
        Ok(database_dir)
    })();

    let unlock_result = FileExt::unlock(&lock);
    match (result, unlock_result) {
        (Ok(path), Ok(())) => Ok(path),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn validate_database_name(name: &str) -> io::Result<()> {
    let path = Path::new(name);
    if name.is_empty()
        || path.components().count() != 1
        || !path.file_name().is_some_and(|n| n == name)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid database filename: {name}"),
        ));
    }
    Ok(())
}

fn move_database_with_sidecars(root: &Path, database_dir: &Path, name: &str) -> io::Result<()> {
    let source = root.join(name);
    let destination = database_dir.join(name);

    // The canonical database wins as a complete group. Never attach sidecars
    // from an older copy, even when the two main files happen to be identical.
    match fs::symlink_metadata(&destination) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(with_io_context(
                error,
                format!("inspect canonical database {}", destination.display()),
            ));
        }
    }
    if name == "local.db" {
        if root.join("notebook-registry-initialized").try_exists()? {
            return Err(io::Error::new(io::ErrorKind::NotFound,
                "initialized notebook registry is missing; automatic import of potentially stale legacy data is disabled"));
        }
        for suffix in ["-wal", "-shm", "-journal"] {
            if fs::symlink_metadata(database_dir.join(format!("{name}{suffix}"))).is_ok() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "notebook registry is missing but SQLite companions remain; recovery required",
                ));
            }
        }
    } else {
        // Other runtime stores may preserve orphan companions before rebuilding.
        super::backup_database(&destination)?;
    }
    match fs::metadata(&source) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(with_io_context(
                error,
                format!("inspect legacy database {}", source.display()),
            ));
        }
    }
    // VACUUM INTO includes committed WAL contents in a standalone database.
    // Only publish after SQLite has closed the snapshot. Never split the
    // source main file from its WAL, even if the process exits mid-migration.
    let temporary = database_dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let snapshot = (|| -> io::Result<()> {
        let conn = rusqlite::Connection::open_with_flags(
            &source,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|error| {
            with_io_context(
                io::Error::other(error),
                format!("open legacy database {} read-only", source.display()),
            )
        })?;
        conn.execute("VACUUM INTO ?1", [temporary.to_string_lossy().as_ref()])
            .map_err(|error| {
                with_io_context(
                    io::Error::other(error),
                    format!(
                        "snapshot legacy database {} to {}",
                        source.display(),
                        temporary.display()
                    ),
                )
            })?;
        drop(conn);
        if name == "local.db" {
            let snapshot = rusqlite::Connection::open_with_flags(
                &temporary,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(io::Error::other)?;
            let check: String = snapshot
                .query_row("PRAGMA quick_check", [], |row| row.get(0))
                .map_err(io::Error::other)?;
            if check != "ok" {
                return Err(io::Error::new(io::ErrorKind::InvalidData, check));
            }
            snapshot.prepare("SELECT id, name, icon, path, is_default, created_at, updated_at FROM notebooks")
                .map_err(io::Error::other)?;
        }
        OpenOptions::new()
            .write(true)
            .open(&temporary)
            .map_err(|error| {
                with_io_context(
                    error,
                    format!("open database snapshot {}", temporary.display()),
                )
            })?
            .sync_all()
            .map_err(|error| {
                with_io_context(
                    error,
                    format!("flush database snapshot {}", temporary.display()),
                )
            })?;
        // A hard link publishes this standalone snapshot atomically and refuses
        // to replace a target created outside the cooperative layout lock.
        fs::hard_link(&temporary, &destination).map_err(|error| {
            with_io_context(
                error,
                format!(
                    "publish database snapshot {} as {}",
                    temporary.display(),
                    destination.display()
                ),
            )
        })?;
        let _ = fs::remove_file(&temporary);
        Ok(())
    })();
    if let Err(error) = snapshot {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}
