/** Keep each upload below the server's request and note-count limits. */
export const BACKUP_BATCH_BYTES = Math.floor(4.8 * 1024 * 1024);
export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
export type BackupBatch = { body: string; count: number };

export function prepareBackupBatches(value: unknown): { batches: BackupBatch[]; total: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("这个文件不是有效的 JSON 备份。");
  }
  const backup = value as Record<string, unknown>;
  if (backup.version !== 1 || !Array.isArray(backup.notes)) {
    throw new Error("请选择包含 notes 数组的版本 1 备份文件。");
  }
  const encoder = new TextEncoder();
  const baseBytes = encoder.encode(JSON.stringify({ ...backup, notes: [] })).byteLength;
  if (baseBytes >= BACKUP_BATCH_BYTES) throw new Error("备份信息过大，请移除额外内容后重试。");
  const batches: BackupBatch[] = [];
  let pending: unknown[] = [];
  let size = baseBytes;
  const flush = () => {
    if (!pending.length) return;
    batches.push({ body: JSON.stringify({ ...backup, notes: pending }), count: pending.length });
    pending = [];
    size = baseBytes;
  };
  for (const note of backup.notes) {
    if (!note || typeof note !== "object" || Array.isArray(note)) {
      throw new Error("备份中的笔记格式无效，请选择完整的备份文件。");
    }
    const noteBytes = encoder.encode(JSON.stringify(note)).byteLength;
    if (baseBytes + noteBytes > BACKUP_BATCH_BYTES) {
      throw new Error("备份中有单篇笔记过大，请先拆分该笔记再导入。");
    }
    if (pending.length === 500 || size + noteBytes + (pending.length ? 1 : 0) > BACKUP_BATCH_BYTES) flush();
    size += noteBytes + (pending.length ? 1 : 0);
    pending.push(note);
  }
  flush();
  return { batches, total: backup.notes.length };
}
