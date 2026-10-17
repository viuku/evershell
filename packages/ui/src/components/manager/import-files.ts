import type { SourceInfo } from '../../core/importers/sources';
import { extOf, fileName } from '../../core/importers/text';
import type { ImportFile } from '../../core/importers/types';

// 把文件选择器 / 拖放得到的 File 变成解析器要的 ImportFile：带相对路径、读成字节。

/** 单个文件超过这个大小就不读（配置文件都很小，大文件多半是选错了目录） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface PickedFile {
  file: File;
  /** 选文件夹或拖文件夹时带目录的相对路径 */
  path: string;
}

export function pickedFromList(list: FileList | File[]): PickedFile[] {
  return Array.from(list).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/** 拖放：文件夹要通过 FileSystemEntry 递归展开 */
export async function pickedFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null;
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return pickedFromList(dt.files);
  const out: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries 一次只给一批，读到空为止
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, path);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

export interface CollectResult {
  files: ImportFile[];
  /** 因为扩展名不符、隐藏文件或太大而没读的数量 */
  skipped: number;
}

/** 按来源过滤扩展名，跳过隐藏文件和大文件，读出字节 */
export async function collectImportFiles(picked: PickedFile[], source: SourceInfo): Promise<CollectResult> {
  const files: ImportFile[] = [];
  let skipped = 0;
  for (const { file, path } of picked) {
    const name = fileName(path);
    const wrongExt = source.extensions.length > 0 && !source.extensions.includes(extOf(path));
    if (name.startsWith('.') || file.size > MAX_FILE_BYTES || wrongExt) {
      skipped++;
      continue;
    }
    files.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return { files, skipped };
}
