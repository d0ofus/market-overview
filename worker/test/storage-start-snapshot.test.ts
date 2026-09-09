import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { storageStartSnapshotHash } from "../scripts/storage-start-snapshot";

it("uses the analyzer's stable backup hash without modifying source bytes and notices later changes", () => {
  const prefix = join(tmpdir(), "storage-start-hash-test-"), directory = mkdtempSync(prefix), file = join(directory, "source.sqlite");
  const raw = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  try {
    execFileSync("python", ["-c", `import sqlite3,sys
db=sqlite3.connect(sys.argv[1]);db.execute('CREATE TABLE prices(id INTEGER PRIMARY KEY,c REAL)');db.commit()
for i in range(10):db.execute('INSERT INTO prices VALUES(?,?)',(i,i+1.5));db.commit()
db.close()`, file], { windowsHide: true, stdio: "pipe" });
    const original = raw(), copied = storageStartSnapshotHash(file, directory);
    expect(copied).toMatch(/^[a-f0-9]{64}$/);
    expect(copied).not.toBe(original);
    expect(storageStartSnapshotHash(file, directory)).toBe(copied);
    expect(raw()).toBe(original);
    execFileSync("python", ["-c", "import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute('UPDATE prices SET c=100 WHERE id=1');db.commit();db.close()", file],
      { windowsHide: true, stdio: "pipe" });
    expect(storageStartSnapshotHash(file, directory)).not.toBe(copied);
  } finally {
    if (!directory.startsWith(prefix)) throw new Error("Unsafe snapshot test cleanup path");
    rmSync(directory, { recursive: true, force: true });
  }
});
