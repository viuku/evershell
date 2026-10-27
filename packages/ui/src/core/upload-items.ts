import type { FileEntry } from '../types';

// 要上传的本机文件和文件夹：从文件选择框选的，或者从访达 / 资源管理器拖进文件区的。
// 拖进来的文件夹展开成里面的每个子文件夹和文件，路径是相对的（dist/js/app.js），空文件夹也保留。

export interface UploadItem {
  /** 相对路径，第一段是拖进来的那一项的名字 */
  path: string;
  /** 文件内容；文件夹为 null */
  file: File | null;
}

export interface PickedUploads {
  items: UploadItem[];
  /** 读不出来的（比如网盘里“仅在线”的文件），相对路径 */
  unreadable: string[];
}

/** 文件夹里的这些文件不传：访达自己的记录文件，传到服务器上没用 */
const JUNK = new Set(['.DS_Store']);

export function itemsFromFiles(list: FileList | readonly File[]): PickedUploads {
  return { items: Array.from(list).map((file) => ({ path: file.name, file })), unreadable: [] };
}

/** 拖动的东西里有本机文件（拖的是网页里的文字、链接时不接） */
export function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files');
}

/**
 * 文件拖到没人接的地方（终端、状态栏）时什么也不做。不拦的话网页内核会把整个窗口换成那个文件，界面就没了。
 * 接拖放的地方（文件区、导入窗口）自己调了 preventDefault，这里不管。每个窗口启动时调一次，返回取消函数
 */
export function guardStrayFileDrops(): () => void {
  const onOver = (e: DragEvent) => {
    if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  };
  const onDrop = (e: DragEvent) => {
    if (!e.defaultPrevented && hasFiles(e.dataTransfer)) e.preventDefault();
  };
  document.addEventListener('dragover', onOver);
  document.addEventListener('drop', onDrop);
  return () => {
    document.removeEventListener('dragover', onOver);
    document.removeEventListener('drop', onDrop);
  };
}

/**
 * 拖放进来的文件和文件夹，文件夹通过 FileSystemEntry 递归展开。
 * 必须在 drop 事件里同步调用：事件处理完 DataTransfer 就读不到了，返回的 Promise 可以之后再等。
 */
export function itemsFromDrop(dt: DataTransfer): Promise<PickedUploads> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null;
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return Promise.resolve(itemsFromFiles(dt.files));
  return (async () => {
    const out: PickedUploads = { items: [], unreadable: [] };
    for (const e of entries) await walk(e, '', out);
    return out;
  })();
}

async function walk(entry: FileSystemEntry, prefix: string, out: PickedUploads): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  try {
    if (entry.isFile) {
      if (prefix && JUNK.has(entry.name)) return;
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.items.push({ path, file });
    } else if (entry.isDirectory) {
      out.items.push({ path, file: null });
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries 一次只给一批，读到空为止
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, path, out);
      }
    }
  } catch {
    out.unreadable.push(path);
  }
}

function topName(path: string): string {
  const i = path.indexOf('/');
  return i < 0 ? path : path.slice(0, i);
}

export interface UploadClash {
  name: string;
  /** 两边都是文件夹：覆盖时合并进去 */
  merge: boolean;
}

/** 拖进来的最上一层里，和目标文件夹里已有的重名的 */
export function findClashes(items: readonly UploadItem[], existing: readonly FileEntry[]): UploadClash[] {
  const there = new Map(existing.map((e) => [e.name, e]));
  const out: UploadClash[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const name = topName(it.path);
    if (seen.has(name)) continue;
    seen.add(name);
    const old = there.get(name);
    if (!old) continue;
    const isDir = items.some((x) => x.path === name && x.file === null);
    out.push({ name, merge: isDir && old.kind === 'dir' });
  }
  return out;
}

/** 最上一层有几项 */
export function topCount(items: readonly UploadItem[]): number {
  return new Set(items.map((it) => topName(it.path))).size;
}

/** 去掉最上一层名字在 names 里的（选了“跳过”） */
export function withoutTop(items: readonly UploadItem[], names: readonly string[]): UploadItem[] {
  const skip = new Set(names);
  return items.filter((it) => !skip.has(topName(it.path)));
}

/**
 * 要先建好的文件夹（相对路径），浅的在前：拖进来的文件夹本身，以及文件所在的每一级。
 * 只选了文件时为空
 */
export function foldersToCreate(items: readonly UploadItem[]): string[] {
  const dirs = new Set<string>();
  for (const it of items) {
    const parts = it.path.split('/');
    const upto = it.file === null ? parts.length : parts.length - 1;
    for (let i = 1; i <= upto; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
}
