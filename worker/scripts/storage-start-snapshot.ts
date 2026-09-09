import { execFileSync } from "node:child_process";

/** Match analyze-eod-storage.py's SQLite backup hash, including committed WAL
 * state and SQLite's destination-header counters. Raw file hashes differ. */
export function storageStartSnapshotHash(sourcePath: string, temporaryRoot: string): string {
  const script = `import hashlib,pathlib,sqlite3,sys,tempfile
source=pathlib.Path(sys.argv[1]).resolve()
root=pathlib.Path(sys.argv[2]).resolve()
if not source.is_file() or not root.is_dir(): raise ValueError('invalid snapshot paths')
with tempfile.TemporaryDirectory(prefix='storage-start-hash-',dir=root) as temporary:
 folder=pathlib.Path(temporary).resolve()
 if folder.parent!=root: raise ValueError('unsafe temporary path')
 target=folder/'source.sqlite'
 original=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)
 copy=sqlite3.connect(target)
 try: original.backup(copy)
 finally: original.close();copy.close()
 digest=hashlib.sha256()
 with target.open('rb') as handle:
  for chunk in iter(lambda:handle.read(1024*1024),b''): digest.update(chunk)
 print(digest.hexdigest())`;
  let hash: string;
  try { hash = execFileSync("python", ["-c", script, sourcePath, temporaryRoot], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024,
  }).trim(); } catch { throw new Error("storage-start-snapshot-checksum-unavailable"); }
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("storage-start-snapshot-checksum-invalid");
  return hash;
}
