//! Pi 子进程的执行环境探测。
//!
//! Pi 以 RPC 子进程形式运行，`bash` 工具的 shell 与环境全部来自它自己的
//! `process.env`（SDK 的 `spawnHook` 在 RPC 模式下不可用）。因此宿主必须在
//! **进程边界**把环境准备好：
//!
//! 1. macOS 从 Finder 启动的 `.app` 继承 launchd 的最小 PATH
//!    (`/usr/bin:/bin:/usr/sbin:/sbin`)，用户装了 Homebrew / nvm / uv 的工具
//!    在 `bash` 工具里全部不可见。这里向登录 shell 取一次真实 PATH 并缓存。
//! 2. Windows 没有 `/bin/bash`：Pi 的 bash 工具只认 `settings.json` 的
//!    `shellPath`、Program Files 下的 Git Bash、或 PATH 上的 `bash.exe`。
//!    都没有时应当改用 Pi 内置的 `powershell` 工具（Windows 必装，零依赖）。
//! 3. Pi 的 `grep` / `find` 没有 JS 兜底，缺 `rg` / `fd` 时会去 GitHub 下载，
//!    失败即报错。所以只在确认可用时才把这两个工具交给模型。

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use tokio::process::Command;
use tokio::sync::OnceCell;

use crate::agent_external::cli_resolver::{is_executable_file, which_in_path};

/// 登录 shell 挂死时不能拖住会话启动。
const LOGIN_SHELL_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1200);
const PATH_START_MARKER: &str = "__FLOWIX_LOGIN_PATH_START__";
const PATH_END_MARKER: &str = "__FLOWIX_LOGIN_PATH_END__";

/// Pi 的 shell 工具在本平台上能落到哪个内置工具名。
///
/// `PowerShell` 与 `None` 只在 Windows 上由 `detect_shell` 构造，非 Windows
/// 构建里只有测试会用到。
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ShellKind {
    /// Pi 的 `bash` 工具；unix 上由 Pi 自己在 `/bin/bash` 与 `sh` 之间回退。
    Bash,
    /// Windows 上没有任何 bash 时的零依赖方案。
    PowerShell,
    /// 连 powershell 都找不到时才成立，正常 Windows 不会出现。
    None,
}

impl ShellKind {
    pub(crate) fn tool_name(self) -> Option<&'static str> {
        match self {
            ShellKind::Bash => Some("bash"),
            ShellKind::PowerShell => Some("powershell"),
            ShellKind::None => None,
        }
    }
}

/// 本次会话可用的执行能力。工具清单由它求交得出，而不是写死。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PiCapabilities {
    pub shell: ShellKind,
    pub ripgrep: bool,
    pub fd: bool,
}

/// 登录 shell 的 PATH 只解析一次。每次 spawn 都跑一遍登录 shell 会让
/// 会话启动多出几百毫秒，而 PATH 在一次应用生命周期内不会变。
static LOGIN_PATH: OnceCell<Option<OsString>> = OnceCell::const_new();

/// 解析一次当前用户的登录 shell PATH（仅 unix；Windows GUI 进程本就继承
/// 完整用户环境）。返回值已与当前进程 PATH 合并，不会丢掉任何条目。
pub(crate) async fn child_path() -> Option<OsString> {
    LOGIN_PATH
        .get_or_init(|| async { resolve_login_shell_path().await })
        .await
        .clone()
}

/// 把探测到的 PATH 挂到 Pi 子进程上。Windows 的环境变量名是 `Path`，
/// 写成 `PATH` 会与继承来的 `Path` 并存出两条记录。
pub(crate) fn apply_child_path(command: &mut Command, path: Option<&OsStr>) {
    let Some(path) = path else { return };
    let key = if cfg!(windows) { "Path" } else { "PATH" };
    command.env(key, path);
}

/// 探测 Pi 在本机的执行能力。`path` 应当是 [`child_path`] 的结果 —— 用宿主
/// 自己的最小 PATH 去找 `rg` 会得出错误的阴性结论。
pub(crate) fn capabilities(path: Option<&OsStr>, custom_shell: Option<&Path>) -> PiCapabilities {
    let agent_bin = super::runtime::pi_config_dir()
        .ok()
        .map(|dir| dir.join("bin"));
    PiCapabilities {
        shell: detect_shell(path, custom_shell),
        ripgrep: has_binary("rg", path, agent_bin.as_deref()),
        fd: has_binary("fd", path, agent_bin.as_deref()),
    }
}

fn detect_shell(path: Option<&OsStr>, custom_shell: Option<&Path>) -> ShellKind {
    if custom_shell.is_some_and(is_executable_file) {
        return ShellKind::Bash;
    }

    #[cfg(windows)]
    {
        if windows_bash_candidates()
            .into_iter()
            .any(|candidate| is_executable_file(&candidate))
        {
            return ShellKind::Bash;
        }
        if which_in_path("bash", path).is_some() {
            return ShellKind::Bash;
        }
        if windows_powershell().is_some() {
            return ShellKind::PowerShell;
        }
        ShellKind::None
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        // unix 上 Pi 依次尝试 `/bin/bash`、PATH 上的 `bash`，最后回退到
        // `sh -c`。`/bin/sh` 在所有受支持的发行版与 macOS 上都存在。
        ShellKind::Bash
    }
}

/// Pi 先看 `<agentDir>/bin/<name>`，再看 PATH；这里保持同一顺序。
fn has_binary(name: &str, path: Option<&OsStr>, agent_bin: Option<&Path>) -> bool {
    let executable = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    if let Some(dir) = agent_bin {
        if is_executable_file(&dir.join(&executable)) {
            return true;
        }
    }
    which_in_path(&executable, path).is_some()
}

#[cfg(windows)]
fn windows_bash_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(root) = std::env::var_os(key) {
            let root = PathBuf::from(root);
            candidates.push(root.join("Git").join("bin").join("bash.exe"));
            candidates.push(root.join("Git").join("usr").join("bin").join("bash.exe"));
        }
    }
    candidates
}

#[cfg(windows)]
fn windows_powershell() -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot")?;
    [
        "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe",
    ]
    .into_iter()
    .map(|relative| PathBuf::from(&root).join(relative))
    .find(|candidate| is_executable_file(candidate))
}

#[cfg(not(windows))]
async fn resolve_login_shell_path() -> Option<OsString> {
    let shell = resolve_login_shell()?;
    let mut command = Command::new(shell);
    // 用标记把 PATH 夹住：交互式 shell 的 rc 文件可能往 stdout 打东西。
    command
        .arg("-ilc")
        .arg(format!(
            "printf '%s' \"{PATH_START_MARKER}${{PATH}}{PATH_END_MARKER}\""
        ))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(LOGIN_SHELL_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let resolved = extract_marked_path(&stdout)?;
    let current = std::env::var_os("PATH");
    Some(merge_paths(&resolved, current.as_deref()))
}

#[cfg(windows)]
async fn resolve_login_shell_path() -> Option<OsString> {
    // Explorer 启动的进程已经带着完整用户环境；再跑一次 PowerShell 只会
    // 增加启动延迟，拿不到更多东西。
    None
}

#[cfg(not(windows))]
fn resolve_login_shell() -> Option<PathBuf> {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| is_executable_file(path))
        .or_else(|| {
            ["/bin/zsh", "/bin/bash", "/bin/sh"]
                .into_iter()
                .map(PathBuf::from)
                .find(|path| is_executable_file(path))
        })
}

fn extract_marked_path(stdout: &str) -> Option<OsString> {
    let start = stdout.find(PATH_START_MARKER)? + PATH_START_MARKER.len();
    let rest = &stdout[start..];
    let end = rest.find(PATH_END_MARKER)?;
    let path = rest[..end].trim();
    if path.is_empty() {
        None
    } else {
        Some(OsString::from(path))
    }
}

/// 登录 shell 的 PATH 在前，宿主自己的 PATH 补在后面，保持原有优先级。
fn merge_paths(primary: &OsStr, secondary: Option<&OsStr>) -> OsString {
    let mut entries: Vec<PathBuf> = Vec::new();
    for directory in std::env::split_paths(primary) {
        if !entries.contains(&directory) {
            entries.push(directory);
        }
    }
    if let Some(secondary) = secondary {
        for directory in std::env::split_paths(secondary) {
            if !entries.contains(&directory) {
                entries.push(directory);
            }
        }
    }
    std::env::join_paths(entries).unwrap_or_else(|_| primary.to_os_string())
}

#[cfg(test)]
mod tests {
    use super::{extract_marked_path, merge_paths, ShellKind};

    #[test]
    fn extracts_path_between_markers_despite_profile_noise() {
        let stdout = format!(
            "welcome to zsh\n{start}/usr/local/bin:/usr/bin{end}\ntrailing job notice",
            start = super::PATH_START_MARKER,
            end = super::PATH_END_MARKER
        );
        assert_eq!(
            extract_marked_path(&stdout),
            Some(std::ffi::OsString::from("/usr/local/bin:/usr/bin"))
        );
    }

    #[test]
    fn rejects_missing_or_empty_marked_path() {
        assert_eq!(extract_marked_path("no markers here"), None);
        let empty = format!("{}{}", super::PATH_START_MARKER, super::PATH_END_MARKER);
        assert_eq!(extract_marked_path(&empty), None);
    }

    #[test]
    fn merge_keeps_login_priority_and_appends_host_entries() {
        let merged = merge_paths(
            std::ffi::OsStr::new("/opt/homebrew/bin:/usr/bin"),
            Some(std::ffi::OsStr::new("/usr/bin:/bin")),
        );
        let entries: Vec<_> = std::env::split_paths(&merged).collect();
        assert_eq!(entries.len(), 3, "duplicates must collapse: {entries:?}");
        assert_eq!(entries[0], std::path::Path::new("/opt/homebrew/bin"));
        assert_eq!(entries[1], std::path::Path::new("/usr/bin"));
        assert_eq!(entries[2], std::path::Path::new("/bin"));
    }

    #[test]
    fn shell_tool_names_match_pi_builtin_tools() {
        assert_eq!(ShellKind::Bash.tool_name(), Some("bash"));
        assert_eq!(ShellKind::PowerShell.tool_name(), Some("powershell"));
        assert_eq!(ShellKind::None.tool_name(), None);
    }
}
