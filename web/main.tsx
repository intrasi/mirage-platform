import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Run, RunEvent, Candidate, DeviceProfile } from "../shared/schema";
import "./style.css";
import { RuntimeView } from "./RuntimeView";
const done = new Set(["succeeded", "failed", "cancelled"]);
async function api<T = any>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok)
    throw Object.assign(new Error(data.error || "Request failed."), {
      status: r.status,
    });
  return data;
}
const short = (v?: string) => (v ? `${v.slice(0, 12)}…` : "Pending");
function Tag({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`tag ${tone}`}>{children}</span>;
}
function App() {
  const [authenticated, setAuthenticated] = useState(false),
    [loading, setLoading] = useState(true),
    [token, setToken] = useState(""),
    [caps, setCaps] = useState<any>(),
    [error, setError] = useState("");
  const [view, setView] = useState<"runtime" | "setup" | "run" | "history">(
      "runtime",
    ),
    [source, setSource] = useState<"sample" | "github">("sample"),
    [name, setName] = useState("Aster · Sensor calibration"),
    [url, setUrl] = useState(""),
    [revision, setRevision] = useState("HEAD");
  const [profile, setProfile] = useState<DeviceProfile>(),
    [validation, setValidation] = useState<any>(),
    [mode, setMode] = useState("catalog"),
    [attempts, setAttempts] = useState(3),
    [busy, setBusy] = useState(false),
    [attachments, setAttachments] = useState<any[]>([]),
    [intake, setIntake] = useState<any>();
  const [run, setRun] = useState<Run>(),
    [history, setHistory] = useState<Run[]>([]),
    [events, setEvents] = useState<RunEvent[]>([]),
    [selected, setSelected] = useState<string>(),
    [tab, setTab] = useState<"source" | "proof" | "analysis">("source");
  const [raw, setRaw] = useState(1000),
    [gain, setGain] = useState(256),
    [offset, setOffset] = useState(-10),
    [calculation, setCalculation] = useState<any>();
  async function bootstrap() {
    try {
      const c = await api("/capabilities");
      setCaps(c);
      setProfile(c.profiles[0]);
      setAuthenticated(true);
      setHistory(await api("/runs"));
      setAttachments(await api("/attachments"));
    } catch (e: any) {
      if (e.status !== 401) setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void bootstrap();
  }, []);
  useEffect(() => {
    if (!profile || !authenticated) return;
    api("/profiles/validate", profile)
      .then(setValidation)
      .catch((e) => setError(e.message));
  }, [profile, authenticated]);
  useEffect(() => {
    if (!run?.id) return;
    const id = run.id;
    setEvents([]);
    api<RunEvent[]>(`/runs/${id}/events?format=json`)
      .then(setEvents)
      .catch((e) => setError(e.message));
    const stream = new EventSource(`/api/runs/${id}/events`);
    stream.onmessage = (e) => {
      const event = JSON.parse(e.data);
      setEvents((old) =>
        old.some((x) => x.sequence === event.sequence)
          ? old
          : [...old, event].sort((a, b) => a.sequence - b.sequence),
      );
      api<Run>(`/runs/${id}`)
        .then((value) => {
          setRun(value);
          if (done.has(value.state)) {
            stream.close();
            void api<Run[]>("/runs").then(setHistory);
          }
        })
        .catch((e) => setError(e.message));
    };
    stream.onerror = () => {
      if (stream.readyState === EventSource.CLOSED) stream.close();
    };
    return () => stream.close();
  }, [run?.id]);
  const candidate =
    run?.candidates.find((x) => x.id === (selected || run.acceptedId)) ||
    run?.candidates.at(-1);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    await act(async () => {
      if (!profile) throw new Error("Choose a device profile.");
      const project = await api("/projects", {
        name,
        source,
        ...(source === "github" ? { url, revision } : {}),
      });
      setIntake(project);
      if (source === "github") return;
      const r = await api<Run>("/runs", {
        projectId: project.id,
        profile,
        policy: { mode, maxAttempts: attempts },
        attachmentIds: attachments.map((x) => x.id),
      });
      setRun(r);
      setSelected(undefined);
      setCalculation(undefined);
      setView("run");
    });
  }
  async function selectRun(id: string) {
    await act(async () => {
      setRun(await api(`/runs/${id}`));
      setSelected(undefined);
      setCalculation(undefined);
      setView("run");
    });
  }
  async function uploadProfile(file?: File) {
    if (!file) return;
    await act(async () => {
      const value = JSON.parse(await file.text());
      const result = await api("/profiles/validate", value);
      setProfile(result.profile);
      setValidation(result);
    });
  }
  async function uploadAttachment(file?: File) {
    if (!file) return;
    await act(async () => {
      if (file.size > 1048576)
        throw new Error("Supporting files must be 1 MiB or smaller.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      const result = await api("/attachments", {
        name: file.name,
        content: btoa(binary),
      });
      setAttachments((old) => [...old, result]);
    });
  }
  if (loading)
    return (
      <main className="login">
        <div className="wordmark">◈ MIRAGE</div>
        <p>Opening the workspace…</p>
      </main>
    );
  if (!authenticated)
    return (
      <main className="login">
        <div className="wordmark">◈ MIRAGE</div>
        <Tag tone="lime">PRIVATE WORKSPACE</Tag>
        <h1>
          Protect the work
          <br />
          inside your product.
        </h1>
        <p>Sign in to the software protection workspace.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api("/session", { token });
              setToken("");
              await bootstrap();
            });
          }}
        >
          <label>
            Workspace access code
            <input
              autoFocus
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
          </label>
          <button className="primary" disabled={busy}>
            Open workspace <span>↗</span>
          </button>
        </form>
        <p className="hint">
          Local setup: run <code>npm run token</code> in the platform directory.
        </p>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        <footer>
          Source stays in your workspace. The runtime model runs locally.
        </footer>
      </main>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="wordmark"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView("runtime");
          }}
        >
          ◈ MIRAGE
        </a>
        <div className="workspace">
          <span className="avatar">A</span>
          <div>
            Aster Labs<small>Demonstration workspace</small>
          </div>
        </div>
        <nav aria-label="Workspace navigation">
          <button
            className={view === "runtime" ? "active" : ""}
            onClick={() => setView("runtime")}
          >
            <span>◈</span> Runtime model
          </button>
          <button
            className={view === "setup" ? "active" : ""}
            onClick={() => setView("setup")}
          >
            <span>▧</span> Protection setup
          </button>
          <button
            className={view === "run" ? "active" : ""}
            disabled={!run}
            onClick={() => setView("run")}
          >
            <span>◎</span> Current run
            {run && !done.has(run.state) && <i className="pulse" />}
          </button>
          <button
            className={view === "history" ? "active" : ""}
            onClick={() => {
              setView("history");
              void api<Run[]>("/runs").then(setHistory);
            }}
          >
            <span>◷</span> Run history <small>{history.length}</small>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="environment">
            <i /> {caps.target}
            <small>
              {caps.hosted ? "Hosted worker" : "Trusted local worker"}
            </small>
          </div>
          <p>
            Private demo · 7-day retention
            <br />
            No training use of source
          </p>
          <button
            className="quiet"
            onClick={() =>
              void act(async () => {
                await api("/session", undefined, "DELETE");
                setAuthenticated(false);
              })
            }
          >
            Sign out ↗
          </button>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <span>
            Workspace <b>/</b>{" "}
            {view === "runtime"
              ? "Runtime model"
              : view === "setup"
                ? "New protection run"
                : view === "history"
                  ? "Run history"
                  : "Protection run"}
          </span>
          <Tag tone={view === "runtime" || caps.proof ? "lime" : "amber"}>
            {view === "runtime"
              ? "LOCAL TRANSFORMER"
              : caps.proof
                ? "CBMC CONNECTED"
                : "PROOF UNAVAILABLE"}
          </Tag>
        </header>
        <main>
          {view === "runtime" && <RuntimeView />}
          {error && (
            <div className="error global-error" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {view === "setup" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">SOFTWARE PROTECTION / NEW RUN</div>
                  <h1>
                    Your algorithm.
                    <br />
                    <em>Harder to understand.</em>
                  </h1>
                  <p>
                    Transform the code. Prove the behavior. Measure the result.
                  </p>
                </div>
                <div className="intro-note">
                  <span>01 — PROOF OF CONCEPT</span>
                  <p>
                    A complete workflow for one calibration function. Each
                    result states what was verified.
                  </p>
                  <Tag>NO PROTECTION CLAIM WITHOUT EVIDENCE</Tag>
                </div>
              </div>
              <div className="setup-grid">
                <section className="setup-main">
                  <div className="panel">
                    <div className="section-heading">
                      <span className="step">01</span>
                      <div>
                        <h2>Connect the software</h2>
                        <p>
                          Start with the fictional Aster sensor, or import
                          repository metadata.
                        </p>
                      </div>
                    </div>
                    <div className="segmented">
                      <button
                        className={source === "sample" ? "chosen" : ""}
                        onClick={() => {
                          setSource("sample");
                          setIntake(undefined);
                        }}
                      >
                        Included sample
                      </button>
                      <button
                        className={source === "github" ? "chosen" : ""}
                        onClick={() => setSource("github")}
                      >
                        GitHub repository
                      </button>
                    </div>
                    <label>
                      Project name
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={100}
                      />
                    </label>
                    {source === "sample" ? (
                      <div className="sample">
                        <div className="sample-icon">ƒ</div>
                        <div>
                          <strong>Sensor calibration calculator</strong>
                          <p>
                            C11 · bounded integer arithmetic · one protected
                            function
                          </p>
                          <code>calibrate(raw, gain_q8, offset)</code>
                        </div>
                        <Tag tone="lime">READY</Tag>
                      </div>
                    ) : (
                      <>
                        <label>
                          Public GitHub URL
                          <input
                            placeholder="https://github.com/company/repository"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                          />
                        </label>
                        <label>
                          Revision
                          <input
                            value={revision}
                            onChange={(e) => setRevision(e.target.value)}
                          />
                        </label>
                        <div className="notice">
                          Repository metadata can be imported. Execution needs a
                          reviewed sandbox and build adapter.
                        </div>
                      </>
                    )}
                    {intake && source === "github" && (
                      <div className="notice good">
                        Imported commit {short(intake.snapshot.commit)}.{" "}
                        {intake.snapshot.inventory.length} files recorded.
                        Execution is unavailable.
                      </div>
                    )}
                  </div>
                  <div className="panel">
                    <div className="section-heading">
                      <span className="step">02</span>
                      <div>
                        <h2>Describe the target</h2>
                        <p>
                          Choose a supported environment or upload a hardware
                          profile.
                        </p>
                      </div>
                    </div>
                    <label>
                      Execution profile
                      <select
                        value={
                          caps.profiles.some(
                            (p: DeviceProfile) => p.name === profile?.name,
                          )
                            ? profile?.name
                            : "custom"
                        }
                        onChange={(e) =>
                          setProfile(
                            caps.profiles.find(
                              (p: DeviceProfile) => p.name === e.target.value,
                            ),
                          )
                        }
                      >
                        {caps.profiles.map((p: DeviceProfile) => (
                          <option key={p.name} value={p.name}>
                            {p.name}
                          </option>
                        ))}
                        {profile &&
                          !caps.profiles.some(
                            (p: DeviceProfile) => p.name === profile.name,
                          ) && <option value="custom">{profile.name}</option>}
                      </select>
                    </label>
                    <div className="fields">
                      <label>
                        Memory budget <span>MiB</span>
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={profile?.ramMiB || 0}
                          onChange={(e) =>
                            profile &&
                            setProfile({
                              ...profile,
                              ramMiB: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Storage budget <span>MiB</span>
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={profile?.storageMiB || 0}
                          onChange={(e) =>
                            profile &&
                            setProfile({
                              ...profile,
                              storageMiB: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Calculation batch <span>ms maximum</span>
                        <input
                          type="number"
                          min="0.001"
                          max="100"
                          step="0.001"
                          value={profile?.maxBatchMs || 100}
                          onChange={(e) =>
                            profile &&
                            setProfile({
                              ...profile,
                              maxBatchMs: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    </div>
                    <label>
                      Model placement
                      <select
                        value={profile?.modelPolicy}
                        onChange={(e) =>
                          profile &&
                          setProfile({
                            ...profile,
                            modelPolicy: e.target.value as any,
                          })
                        }
                      >
                        <option value="auto">
                          Assess device capacity automatically
                        </option>
                        <option value="build-only">
                          Use the model during builds only
                        </option>
                        <option value="device-requested">
                          Assess a model inside the device
                        </option>
                      </select>
                    </label>
                    <div className="uploads">
                      <label className="file-button">
                        ↑ Upload profile JSON
                        <input
                          type="file"
                          accept=".json"
                          onChange={(e) =>
                            void uploadProfile(e.target.files?.[0])
                          }
                        />
                      </label>
                      <label className="file-button">
                        ＋ Attach hardware file
                        <input
                          type="file"
                          onChange={(e) =>
                            void uploadAttachment(e.target.files?.[0])
                          }
                        />
                      </label>
                    </div>
                    {attachments.length > 0 && (
                      <p className="hint">
                        {attachments.map((x) => x.name).join(", ")} · stored for
                        review, never executed
                      </p>
                    )}
                    {validation && (
                      <div
                        className={`notice ${validation.supported ? "good" : ""}`}
                      >
                        {validation.supported
                          ? "This target can run on the configured worker."
                          : validation.gaps.join(" ")}
                        <small>{validation.placement.reason}</small>
                      </div>
                    )}
                  </div>
                  <div className="panel">
                    <div className="section-heading">
                      <span className="step">03</span>
                      <div>
                        <h2>Set the protection search</h2>
                        <p>
                          The verification policy stays fixed throughout the
                          run.
                        </p>
                      </div>
                    </div>
                    <div className="fields">
                      <label>
                        Proposal source
                        <select
                          value={mode}
                          onChange={(e) => setMode(e.target.value)}
                        >
                          <option value="catalog">
                            Deterministic catalog · real verification
                          </option>
                          <option
                            value="model"
                            disabled={!caps.model.configured}
                          >
                            Live model{" "}
                            {caps.model.configured
                              ? `· ${caps.model.id}`
                              : "· not configured"}
                          </option>
                        </select>
                      </label>
                      <label>
                        Candidate attempts
                        <input
                          type="number"
                          min="1"
                          max="12"
                          value={attempts}
                          onChange={(e) => setAttempts(Number(e.target.value))}
                        />
                      </label>
                    </div>
                    <div className="policy-tags">
                      <Tag>15 MINUTES</Tag>
                      <Tag>100,000 TOKENS MAXIMUM</Tag>
                      <Tag>$5 MODEL COST CEILING</Tag>
                    </div>
                    <p className="hint">
                      Catalog mode uses no model tokens. It does not demonstrate
                      an autonomous model.
                    </p>
                  </div>
                </section>
                <aside className="setup-summary">
                  <div className="panel summary-panel">
                    <div className="eyebrow">RELEASE CHECKS</div>
                    <h2>Behavior is the contract.</h2>
                    <ol className="check-list">
                      <li>
                        <span>01</span>
                        <div>
                          Build the baseline
                          <small>Record the exact compiler and artifact.</small>
                        </div>
                      </li>
                      <li>
                        <span>02</span>
                        <div>
                          Reject an incorrect control
                          <small>Require a formal counterexample.</small>
                        </div>
                      </li>
                      <li>
                        <span>03</span>
                        <div>
                          Prove each transformation
                          <small>
                            Check every input in the declared domain.
                          </small>
                        </div>
                      </li>
                      <li>
                        <span>04</span>
                        <div>
                          Measure the executable
                          <small>
                            Compare 10,240 inputs and resource limits.
                          </small>
                        </div>
                      </li>
                      <li>
                        <span>05</span>
                        <div>
                          Package the accepted result
                          <small>
                            Export source, executable, and evidence.
                          </small>
                        </div>
                      </li>
                    </ol>
                    <button
                      className="primary full"
                      onClick={() => void start()}
                      disabled={
                        busy || (source === "sample" && !validation?.supported)
                      }
                    >
                      {busy
                        ? "Preparing…"
                        : source === "sample"
                          ? "Start protection run"
                          : "Import repository"}
                      <span>↗</span>
                    </button>
                    <p className="hint centered">
                      {source === "sample"
                        ? "Only the included trusted sample runs locally."
                        : "Import does not execute repository code."}
                    </p>
                  </div>
                  <div className="scope-note">
                    <span className="eyebrow">CURRENT ENVIRONMENT</span>
                    <p>
                      {caps.hosted
                        ? "Hosted execution is configured."
                        : "Hosted Linux execution is not configured."}
                    </p>
                    <p>
                      {caps.model.configured
                        ? "Live model proposals are available."
                        : "Live model proposals are not configured."}
                    </p>
                    <p>Custom hardware execution requires a device adapter.</p>
                  </div>
                </aside>
              </div>
            </>
          )}
          {view === "history" && (
            <>
              <div className="page-heading compact">
                <div>
                  <div className="eyebrow">AUDIT TRAIL</div>
                  <h1>Every run. Every result.</h1>
                  <p>
                    Open a run to inspect its inputs, decisions, and evidence.
                  </p>
                </div>
                <button className="primary" onClick={() => setView("setup")}>
                  New run ↗
                </button>
              </div>
              <div className="panel">
                {history.length === 0 ? (
                  <div className="empty">
                    No runs yet. Start with the included calibration sample.
                  </div>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Created</th>
                          <th>Target</th>
                          <th>Mode</th>
                          <th>State</th>
                          <th>Accepted</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((r) => (
                          <tr key={r.id}>
                            <td>{new Date(r.createdAt).toLocaleString()}</td>
                            <td>
                              {r.profile.operatingSystem} /{" "}
                              {r.profile.architecture}
                            </td>
                            <td>{r.policy.mode}</td>
                            <td>
                              <Tag
                                tone={
                                  r.state === "succeeded"
                                    ? "lime"
                                    : r.state === "failed"
                                      ? "red"
                                      : "muted"
                                }
                              >
                                {r.state}
                              </Tag>
                            </td>
                            <td>{r.acceptedId ? "Yes" : "No"}</td>
                            <td>
                              <button
                                className="quiet"
                                onClick={() => void selectRun(r.id)}
                              >
                                Inspect ↗
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
          {view === "run" && run && (
            <>
              <div className="page-heading compact">
                <div>
                  <div className="eyebrow">CALIBRATION / {short(run.id)}</div>
                  <h1>
                    {run.state === "succeeded"
                      ? "Verified. Packaged. Ready."
                      : run.state === "failed"
                        ? "This run needs attention."
                        : run.state === "cancelled"
                          ? "Run cancelled."
                          : "Protection in progress."}
                  </h1>
                  <p>
                    {run.state === "succeeded"
                      ? "The accepted build preserves the declared behavior. Review the measured protection outcome."
                      : run.error ||
                        "The worker records each proposal and independent check."}
                  </p>
                </div>
                <div className="run-actions">
                  <Tag
                    tone={
                      run.state === "succeeded"
                        ? "lime"
                        : run.state === "failed"
                          ? "red"
                          : "amber"
                    }
                  >
                    {run.state.toUpperCase()}
                  </Tag>
                  {!done.has(run.state) && (
                    <button
                      onClick={() =>
                        void act(async () => {
                          setRun(await api(`/runs/${run.id}/cancel`, {}));
                        })
                      }
                    >
                      Cancel run
                    </button>
                  )}
                  <button className="quiet" onClick={() => setView("setup")}>
                    New run ↗
                  </button>
                </div>
              </div>
              <div className="metrics">
                <div>
                  <span>FORMAL ACCEPTANCE</span>
                  <strong>{run.acceptedId ? "Proved" : "Pending"}</strong>
                  <small>Exact integer output equality</small>
                </div>
                <div>
                  <span>EXECUTABLE CHECKS</span>
                  <strong>
                    {run.candidates
                      .find((x) => x.id === run.acceptedId)
                      ?.measurement?.differentialCases.toLocaleString() || "—"}
                  </strong>
                  <small>Generated and boundary inputs</small>
                </div>
                <div>
                  <span>PROPOSAL SOURCE</span>
                  <strong>
                    {run.policy.mode === "catalog" ? "Catalog" : "Live model"}
                  </strong>
                  <small>
                    {run.policy.mode === "catalog"
                      ? "Deterministic, explicitly labeled"
                      : caps.model.id}
                  </small>
                </div>
                <div>
                  <span>MODEL SPENDING</span>
                  <strong>${run.modelUsage.costUsd.toFixed(3)}</strong>
                  <small>
                    {run.modelUsage.tokens.toLocaleString()} tokens used
                  </small>
                </div>
              </div>
              <div className="run-grid">
                <section>
                  <div className="panel">
                    <div className="panel-title">
                      <h2>Transformation candidates</h2>
                      <Tag>{run.candidates.length} RECORDED</Tag>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Candidate</th>
                            <th>Origin</th>
                            <th>Proof</th>
                            <th>Decision</th>
                          </tr>
                        </thead>
                        <tbody>
                          {run.candidates.map((c, i) => (
                            <tr
                              key={c.id}
                              className={
                                candidate?.id === c.id ? "selected" : ""
                              }
                            >
                              <td>
                                <button
                                  className="row-link"
                                  onClick={() => {
                                    setSelected(c.id);
                                    setTab("source");
                                  }}
                                >
                                  {c.origin === "injected-control"
                                    ? "Incorrect control"
                                    : c.origin === "conventional"
                                      ? "Conventional baseline"
                                      : c.proposal?.transform ||
                                        `Candidate ${i}`}
                                  {c.id === run.acceptedId && (
                                    <span className="selected-mark"> ◆</span>
                                  )}
                                </button>
                              </td>
                              <td>{c.origin}</td>
                              <td>
                                <Tag
                                  tone={
                                    c.proof?.state === "proved"
                                      ? "lime"
                                      : c.proof?.state === "counterexample"
                                        ? "red"
                                        : "muted"
                                  }
                                >
                                  {c.proof?.state || "pending"}
                                </Tag>
                              </td>
                              <td>
                                {c.accepted
                                  ? "Accepted"
                                  : c.origin === "injected-control" &&
                                      c.proof?.state === "counterexample"
                                    ? "Rejected as expected"
                                    : c.origin === "conventional"
                                      ? "Comparison only"
                                      : "Excluded"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {run.candidates.length === 0 && (
                        <div className="empty">
                          The baseline build is starting.
                        </div>
                      )}
                    </div>
                  </div>
                  {candidate && (
                    <CandidatePanel
                      candidate={candidate}
                      run={run}
                      tab={tab}
                      setTab={setTab}
                    />
                  )}
                  <div className="panel">
                    <div className="panel-title">
                      <div>
                        <h2>Try a fresh input</h2>
                        <p>
                          Run the original and accepted executables on the
                          worker.
                        </p>
                      </div>
                      <Tag>LIVE EXECUTION</Tag>
                    </div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void act(async () =>
                          setCalculation(
                            await api(`/runs/${run.id}/calculate`, {
                              raw,
                              gain_q8: gain,
                              offset,
                            }),
                          ),
                        );
                      }}
                    >
                      <div className="fields">
                        <label>
                          Raw reading
                          <input
                            aria-label="Raw reading"
                            type="number"
                            min="0"
                            max="4095"
                            value={raw}
                            onChange={(e) => setRaw(Number(e.target.value))}
                            required
                          />
                        </label>
                        <label>
                          Gain <span>Q8</span>
                          <input
                            aria-label="Gain"
                            type="number"
                            min="1"
                            max="1024"
                            value={gain}
                            onChange={(e) => setGain(Number(e.target.value))}
                            required
                          />
                        </label>
                        <label>
                          Offset
                          <input
                            aria-label="Offset"
                            type="number"
                            min="-1024"
                            max="1024"
                            value={offset}
                            onChange={(e) => setOffset(Number(e.target.value))}
                            required
                          />
                        </label>
                        <button
                          className="primary"
                          disabled={busy || !run.baseline}
                        >
                          Compare ↗
                        </button>
                      </div>
                    </form>
                    {calculation && (
                      <div className="calculation" aria-live="polite">
                        <div>
                          <span>ORIGINAL</span>
                          <strong>{calculation.original}</strong>
                        </div>
                        <span className="equal">=</span>
                        <div>
                          <span>PROTECTED</span>
                          <strong>{calculation.protected}</strong>
                        </div>
                        <Tag tone={calculation.matches ? "lime" : "red"}>
                          {calculation.matches ? "EXACT MATCH" : "MISMATCH"}
                        </Tag>
                        <small>{calculation.mode}</small>
                      </div>
                    )}
                  </div>
                  {run.state === "succeeded" && (
                    <div className="panel exports">
                      <div>
                        <div className="eyebrow">DELIVERY</div>
                        <h2>Your verified package</h2>
                        <p>
                          Source and private evidence stay separate from the
                          deployable executable.
                        </p>
                      </div>
                      <div className="download-grid">
                        {[
                          [
                            "source",
                            "Source archive",
                            "C source and build instructions",
                          ],
                          [
                            "executable",
                            "Executable package",
                            "Binary and identity manifest",
                          ],
                          [
                            "patch",
                            "Source patch",
                            "Review the exact transformation",
                          ],
                          [
                            "evidence",
                            "Private evidence",
                            "Proof logs, metrics, and analysis",
                          ],
                          [
                            "manifest",
                            "Manifest",
                            "Hashes and target information",
                          ],
                        ].map(([key, title, description]) => (
                          <a
                            key={key}
                            href={`/api/artifacts/${run.artifacts[key]}`}
                            download
                          >
                            <div>
                              <strong>{title}</strong>
                              <small>{description}</small>
                            </div>
                            <span>↓</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
                <aside>
                  <div className="panel activity">
                    <div className="panel-title">
                      <h2>Worker activity</h2>
                      <i className={!done.has(run.state) ? "pulse" : ""} />
                    </div>
                    <div
                      className="event-list"
                      role="log"
                      aria-label="Worker activity"
                    >
                      {events.map((e) => (
                        <div key={e.sequence} className="event">
                          <span className="event-dot" />
                          <div>
                            <small>
                              {new Date(e.time).toLocaleTimeString()} ·{" "}
                              {e.stage}
                            </small>
                            <p>{e.message}</p>
                            {e.evidence.map((id) => (
                              <a
                                key={id}
                                href={`/api/artifacts/${id}`}
                                download
                              >
                                Evidence ↓
                              </a>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="panel scope-note">
                    <div className="eyebrow">EVIDENCE BOUNDARY</div>
                    {run.gaps.map((g) => (
                      <p key={g}>{g}</p>
                    ))}
                    <p>
                      Correctness does not establish resistance to reverse
                      engineering.
                    </p>
                  </div>
                  {Boolean(run.placement) && (
                    <div className="panel scope-note">
                      <div className="eyebrow">DEVICE MODEL ASSESSMENT</div>
                      <h3>{(run.placement as any).decision}</h3>
                      <p>{(run.placement as any).reason}</p>
                      <Tag>NO DEVICE MODEL INCLUDED</Tag>
                    </div>
                  )}
                </aside>
              </div>
            </>
          )}
        </main>
        <footer className="page-footer">
          <span>MIRAGE / SOFTWARE PROTECTION</span>
          <span>Evidence before claims. Behavior before release.</span>
        </footer>
      </div>
    </div>
  );
}
function CandidatePanel({
  candidate: c,
  run,
  tab,
  setTab,
}: {
  candidate: Candidate;
  run: Run;
  tab: string;
  setTab: (t: "source" | "proof" | "analysis") => void;
}) {
  const m = c.measurement;
  return (
    <div className="panel candidate-panel">
      <div className="panel-title">
        <div>
          <h2>Inspect the candidate</h2>
          <p>{c.reason}</p>
        </div>
        <Tag tone={c.accepted ? "lime" : "muted"}>
          {c.accepted ? "ACCEPTED" : "NOT SELECTED"}
        </Tag>
      </div>
      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "source"}
          className={tab === "source" ? "active" : ""}
          onClick={() => setTab("source")}
        >
          Source & measurements
        </button>
        <button
          role="tab"
          aria-selected={tab === "proof"}
          className={tab === "proof" ? "active" : ""}
          onClick={() => setTab("proof")}
        >
          Formal evidence
        </button>
        <button
          role="tab"
          aria-selected={tab === "analysis"}
          className={tab === "analysis" ? "active" : ""}
          onClick={() => setTab("analysis")}
        >
          Reconstruction
        </button>
      </div>
      {tab === "source" && (
        <>
          <div className="code-label">
            <span>calibrate.c</span>
            <span>SHA-256 {short(c.sourceHash)}</span>
          </div>
          <details className="baseline-source">
            <summary>Compare with original source</summary>
            <pre>
              {run.baseline?.originalSource ||
                "Original source is included in the sample directory."}
            </pre>
          </details>
          <pre className="source-code">
            {c.source.split("\n").map((line, i) => (
              <div key={i}>
                <span>{i + 1}</span>
                {line}
              </div>
            ))}
          </pre>
          {m && (
            <div className="measurement-details">
              <div>
                <span>Executable</span>
                <strong>{(m.binaryBytes / 1024).toFixed(1)} KiB</strong>
              </div>
              <div>
                <span>Peak memory</span>
                <strong>{(m.rssBytes / 1048576).toFixed(2)} MiB</strong>
              </div>
              <div>
                <span>10,000-call batch</span>
                <strong>{m.batchMs.toFixed(4)} ms</strong>
              </div>
              <div>
                <span>Baseline ratio</span>
                <strong>{m.slowdown.toFixed(2)}×</strong>
              </div>
              <div>
                <span>Binary change</span>
                <strong>{m.assemblyChanged ? "Retained" : "Removed"}</strong>
              </div>
            </div>
          )}
          <div className="hash-line">
            Binary SHA-256:{" "}
            {c.binaryHash || "No binary accepted for execution."}
          </div>
        </>
      )}
      {tab === "proof" && (
        <>
          <div className="proof-summary">
            <Tag tone={c.proof?.state === "proved" ? "lime" : "red"}>
              {c.proof?.state || "Pending"}
            </Tag>
            <p>
              {c.proof?.tool} {c.proof?.version} ·{" "}
              {((c.proof?.durationMs || 0) / 1000).toFixed(2)} seconds
            </p>
            <p>
              All declared inputs: raw 0–4095, gain 1–1024, offset −1024–1024.
            </p>
            <p>
              Source equivalence excludes compiler correctness and physical
              hardware behavior.
            </p>
          </div>
          <pre className="proof-log">
            {c.proof?.log || "Proof evidence is pending."}
          </pre>
        </>
      )}
      {tab === "analysis" && (
        <div className="analysis-panel">
          {run.reconstruction ? (
            <>
              <p>
                One procedural analyst received each executable under the same
                budget. It used live input and output queries.
              </p>
              {(run.reconstruction as any).analyses.map((a: any) => (
                <div className="analysis-row" key={a.label}>
                  <strong>{a.label}</strong>
                  <span>
                    {a.heldout
                      ? `${a.heldout.matched} / ${a.heldout.cases} judge cases`
                      : "Unavailable"}
                  </span>
                  <Tag tone={a.recovered ? "amber" : "muted"}>
                    {a.recovered ? "RECOVERED" : "NOT RECOVERED"}
                  </Tag>
                </div>
              ))}
              <p className="notice">
                This narrow arithmetic search does not measure general or
                model-based reverse engineering resistance.
              </p>
            </>
          ) : (
            <div className="empty">
              Reconstruction results appear after candidate selection.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
