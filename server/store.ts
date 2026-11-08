import { DatabaseSync } from "node:sqlite";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  readdirSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, initDirectories, hash, jsonHash } from "./config.js";
import type { Run, RunEvent } from "../shared/schema.js";
export class Store {
  db: DatabaseSync;
  directory: string;
  constructor(path = resolve(dataDir, "mirage.sqlite")) {
    initDirectories();
    this.directory = dirname(path);
    mkdirSync(resolve(this.directory, "artifacts"), {
      recursive: true,
      mode: 0o700,
    });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS events(run_id TEXT,sequence INTEGER,time TEXT,stage TEXT,message TEXT,evidence TEXT,PRIMARY KEY(run_id,sequence));
 CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,run_id TEXT,digest TEXT,name TEXT,mime TEXT,bytes INTEGER,created TEXT);
 CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,fingerprint TEXT,result TEXT);
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,time TEXT,action TEXT,subject TEXT);
 CREATE TABLE IF NOT EXISTS lease(id TEXT PRIMARY KEY,owner TEXT,expires INTEGER);`);
    const columns = this.db.prepare("PRAGMA table_info(requests)").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "created")) {
      this.db.exec(
        "ALTER TABLE requests ADD COLUMN created INTEGER NOT NULL DEFAULT 0",
      );
      this.db
        .prepare("UPDATE requests SET created=? WHERE created=0")
        .run(Date.now());
    }
  }
  get<T>(kind: string, id: string): T | undefined {
    const r = this.db
      .prepare("SELECT body FROM records WHERE kind=? AND id=?")
      .get(kind, id) as any;
    return r ? JSON.parse(r.body) : undefined;
  }
  put(kind: string, id: string, v: unknown) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, id, JSON.stringify(v));
  }
  list<T>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT body FROM records WHERE kind=? ORDER BY rowid DESC")
        .all(kind) as any[]
    ).map((r) => JSON.parse(r.body));
  }
  saveRun(r: Run) {
    r.updatedAt = new Date().toISOString();
    this.put("run", r.id, r);
  }
  event(r: Run, stage: string, message: string, evidence: string[] = []) {
    const sequence = Number(
      (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence),0)+1 AS n FROM events WHERE run_id=?",
          )
          .get(r.id) as any
      ).n,
    );
    const time = new Date().toISOString();
    this.db
      .prepare("INSERT INTO events VALUES(?,?,?,?,?,?)")
      .run(r.id, sequence, time, stage, message, JSON.stringify(evidence));
    return { runId: r.id, sequence, time, stage, message, evidence };
  }
  events(id: string, after = 0): RunEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM events WHERE run_id=? AND sequence>? ORDER BY sequence",
        )
        .all(id, after) as any[]
    ).map((r) => ({
      runId: r.run_id,
      sequence: r.sequence,
      time: r.time,
      stage: r.stage,
      message: r.message,
      evidence: JSON.parse(r.evidence),
    }));
  }
  artifact(
    runId: string,
    name: string,
    bytes: Buffer | string,
    mime = "application/octet-stream",
  ) {
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const digest = hash(b);
    const path = resolve(this.directory, "artifacts", digest);
    if (!existsSync(path)) writeFileSync(path, b, { mode: 0o600, flag: "wx" });
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)")
      .run(id, runId, digest, name, mime, b.length, new Date().toISOString());
    return id;
  }
  artifactInfo(id: string) {
    return this.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id) as
      | {
          id: string;
          run_id: string;
          digest: string;
          name: string;
          mime: string;
          bytes: number;
        }
      | undefined;
  }
  artifactBytes(id: string) {
    const a = this.artifactInfo(id);
    if (!a) throw new Error("Artifact does not exist.");
    const b = readFileSync(resolve(this.directory, "artifacts", a.digest));
    if (hash(b) !== a.digest) throw new Error("Artifact hash mismatch.");
    return b;
  }
  audit(action: string, subject: string) {
    this.db
      .prepare("INSERT INTO audit(time,action,subject) VALUES(?,?,?)")
      .run(new Date().toISOString(), action, subject);
  }
  idempotent<T>(key: string, fingerprint: unknown, fn: () => T): T {
    const f = jsonHash(fingerprint);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = this.db
        .prepare("SELECT * FROM requests WHERE key=?")
        .get(key) as any;
      if (r) {
        if (r.fingerprint !== f)
          throw new Error(
            "Idempotency key was already used with different input.",
          );
        this.db.exec("COMMIT");
        return JSON.parse(r.result);
      }
      const result = fn();
      this.db
        .prepare(
          "INSERT INTO requests(key,fingerprint,result,created) VALUES(?,?,?,?)",
        )
        .run(key, f, JSON.stringify(result), Date.now());
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private inFlight = new Map<
    string,
    { fingerprint: string; promise: Promise<any> }
  >();
  async idempotentAsync<T>(
    key: string,
    input: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    const fingerprint = jsonHash(input);
    const previous = this.db
      .prepare("SELECT * FROM requests WHERE key=?")
      .get(key) as any;
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("Idempotency key conflict.");
      return JSON.parse(previous.result);
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new Error("Idempotency key conflict.");
      return pending.promise;
    }
    if (this.get("pending-request", key))
      throw new Error(
        "This request was interrupted. Inspect its evidence before using a new request key.",
      );
    this.put("pending-request", key, {
      fingerprint,
      startedAt: new Date().toISOString(),
    });
    const promise = Promise.resolve()
      .then(action)
      .then((result) => {
        return this.idempotent(key, input, () => result);
      })
      .finally(() => {
        this.inFlight.delete(key);
        this.db
          .prepare("DELETE FROM records WHERE kind='pending-request' AND id=?")
          .run(key);
      });
    this.inFlight.set(key, { fingerprint, promise });
    return promise;
  }
  deleteRun(id: string) {
    const run = this.get<Run>("run", id);
    if (!run) throw new Error("Run does not exist.");
    if (!["succeeded", "failed", "cancelled"].includes(run.state))
      throw new Error("Cancel the active run before deletion.");
    this.audit("run-deleted", id);
    for (const record of this.list<any>("tool"))
      if (record.request?.runId === id)
        this.db
          .prepare("DELETE FROM records WHERE kind='tool' AND id=?")
          .run(record.request.id);
    this.db.prepare("DELETE FROM artifacts WHERE run_id=?").run(id);
    this.db.prepare("DELETE FROM events WHERE run_id=?").run(id);
    this.db
      .prepare(
        "DELETE FROM records WHERE kind IN ('run','run-attachments') AND id=?",
      )
      .run(id);
    rmSync(resolve(this.directory, "work", id), {
      recursive: true,
      force: true,
    });
  }
  collectArtifacts() {
    const refs = new Set(
      (
        this.db.prepare("SELECT DISTINCT digest FROM artifacts").all() as any[]
      ).map((x) => x.digest),
    );
    for (const name of readdirSync(resolve(this.directory, "artifacts")))
      if (/^[a-f0-9]{64}$/.test(name) && !refs.has(name))
        unlinkSync(resolve(this.directory, "artifacts", name));
  }
  acquire(owner: string) {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO lease VALUES('worker',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE lease.expires<? OR lease.owner=?",
      )
      .run(owner, now + 10000, now, owner);
    return (
      (
        this.db
          .prepare("SELECT owner FROM lease WHERE id='worker'")
          .get() as any
      ).owner === owner
    );
  }
  release(owner: string) {
    this.db.prepare("DELETE FROM lease WHERE owner=?").run(owner);
  }
  prune(days = 7) {
    if (!Number.isFinite(days) || days <= 0)
      throw new Error("Retention must be a positive number of days.");
    const cutoff = Date.now() - days * 86400000;
    this.db.prepare("DELETE FROM requests WHERE created<?").run(cutoff);
    for (const r of this.list<Run>("run")) {
      if (
        !["succeeded", "failed", "cancelled"].includes(r.state) ||
        Date.parse(r.updatedAt) > cutoff
      )
        continue;
      this.audit("retention-delete", r.id);
      for (const record of this.list<any>("tool"))
        if (record.request?.runId === r.id)
          this.db
            .prepare("DELETE FROM records WHERE kind='tool' AND id=?")
            .run(record.request.id);
      this.db.prepare("DELETE FROM artifacts WHERE run_id=?").run(r.id);
      this.db.prepare("DELETE FROM events WHERE run_id=?").run(r.id);
      this.db
        .prepare("DELETE FROM records WHERE kind='run' AND id=?")
        .run(r.id);
      this.db
        .prepare("DELETE FROM records WHERE kind='run-attachments' AND id=?")
        .run(r.id);
      rmSync(resolve(this.directory, "work", r.id), {
        recursive: true,
        force: true,
      });
    }
    const projectReferences = new Set(
      this.list<Run>("run").map((run) => run.projectId),
    );
    for (const project of this.list<any>("project")) {
      if (
        projectReferences.has(project.id) ||
        !project.createdAt ||
        Date.parse(project.createdAt) > cutoff
      )
        continue;
      this.db
        .prepare("DELETE FROM records WHERE kind='project' AND id=?")
        .run(project.id);
      if (project.snapshot?.artifactId)
        this.db
          .prepare("DELETE FROM artifacts WHERE id=?")
          .run(project.snapshot.artifactId);
      this.audit("retention-delete-project", project.id);
    }
    const referencedAttachments = new Set([
      ...this.list<string[]>("run-attachments").flat(),
      ...this.list<any>("project")
        .map((p) => p.snapshot?.artifactId)
        .filter(Boolean),
    ]);
    const oldAttachments = this.db
      .prepare(
        "SELECT id FROM artifacts WHERE run_id='workspace' AND created<?",
      )
      .all(new Date(cutoff).toISOString()) as { id: string }[];
    for (const attachment of oldAttachments) {
      if (referencedAttachments.has(attachment.id)) continue;
      this.db.prepare("DELETE FROM artifacts WHERE id=?").run(attachment.id);
      this.db
        .prepare("DELETE FROM records WHERE kind='attachment' AND id=?")
        .run(attachment.id);
      this.audit("retention-delete-attachment", attachment.id);
    }
    const refs = new Set(
      (
        this.db.prepare("SELECT DISTINCT digest FROM artifacts").all() as any[]
      ).map((x) => x.digest),
    );
    for (const f of readdirSync(resolve(this.directory, "artifacts"))) {
      if (/^[a-f0-9]{64}$/.test(f) && !refs.has(f))
        unlinkSync(resolve(this.directory, "artifacts", f));
    }
  }
  close() {
    this.db.close();
  }
}
