/**
 * Cross-platform path utilities for joining notebook and memo paths.
 * On Mac/Linux, uses forward slashes; on Windows, handles both \\ and /.
 *
 * v3 改造: filename 改成磁盘文件名 (含 .md, 不再带 #memoid 后缀),
 * 因此 extractMemoIdFromPath / generateMemoFilename / MEMO_ID_FILENAME_PATTERN
 * 全部移除。memo id 由后端 memo index 持有, 前端从 memo 结构读。
 */

export function joinNotebookMemoPath(notebookPath: string, memoPath: string | null | undefined): string | null {
  if (!memoPath) return null;

  // Remove trailing slashes from notebook path
  const cleanNotebook = notebookPath.replace(/[\\/]+$/, '');
  // Remove leading slashes from memo path
  const cleanMemo = memoPath.replace(/^[\\/]+/, '');

  // Use forward slash as separator - works on all platforms
  return `${cleanNotebook}/${cleanMemo}`;
}

export function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}


/**
 * 跨平台 path 归一: \ → /, 重复 / 压缩。不动大小写 (文件系统权威)。
 * 这个语义是 memo 文档 path 索引的唯一标准 —— buffer / document-store /
 * 事件路径比较都走这里, 不要在其他文件重复定义。
 */
export function canonicalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/** Stable locator key for a local file, independent of any open surface. */
export function fileLocatorKey(path: string): string {
  return `file:${canonicalPath(path)}`;
}

export function canonicalDirectoryPath(path: string): string {
  const canonical = canonicalPath(path);
  const trimmed = canonical.replace(/\/+$/, '');
  return trimmed || (canonical.startsWith('/') ? '/' : canonical);
}

export function parentDirectoryPath(filePath: string, notebookPath: string): string {
  const canonicalFilePath = canonicalPath(filePath).replace(/\/+$/, '');
  const separatorIndex = canonicalFilePath.lastIndexOf('/');
  const parent = separatorIndex >= 0
    ? canonicalFilePath.slice(0, separatorIndex)
    : notebookPath;
  return canonicalDirectoryPath(parent || notebookPath);
}

export function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = canonicalPath(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function fileNameFromPath(filePath: string): string {
  const canonicalFilePath = canonicalPath(filePath).replace(/\/+$/, '');
  return canonicalFilePath.slice(canonicalFilePath.lastIndexOf('/') + 1);
}

export function pathInDirectory(directoryPath: string, filePath: string): string {
  const directory = canonicalDirectoryPath(directoryPath);
  const name = fileNameFromPath(filePath);
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}
