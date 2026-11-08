import React, { useEffect, useState } from "react";

async function request(path: string, seed?: number) {
  const response = await fetch(
    `/api/runtime${path}`,
    seed === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ seed }),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Runtime request failed.");
  return value;
}
const code = (source: string) =>
  source
    .replace(/ \{ /g, " {\n  ")
    .replace(/ ; /g, ";\n  ")
    .replace(/ ; \}/g, ";\n}")
    .replace(/\n  \}/g, "\n}");

export function RuntimeView() {
  const [evidence, setEvidence] = useState<any>();
  const [demo, setDemo] = useState<any>();
  const [seed, setSeed] = useState(100000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const before = evidence?.optimization?.summary?.baseline;
  const after = evidence?.optimization?.summary?.["native-vm-native-model"];
  useEffect(() => {
    request("")
      .then((value) => {
        setEvidence(value);
        setDemo(value.demo);
      })
      .catch((error) => setError(error.message));
  }, []);
  async function run() {
    setBusy(true);
    setError("");
    try {
      setDemo(await request("/demo", seed));
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="runtime-view">
      <div className="page-heading">
        <div>
          <div className="eyebrow">LOCAL MODEL / CUSTOM VIRTUAL MACHINE</div>
          <h1>
            Small model.
            <br />
            <em>Changing code.</em>
          </h1>
          <p>
            The transformer generates C functions. The virtual machine replaces
            inactive regions while the application continues.
          </p>
        </div>
        <div className="intro-note">
          <span>RUNTIME DEMONSTRATION</span>
          <p>
            Model output decodes real application bytecode. A live check tests
            removal, replay, and an earlier model state.
          </p>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="runtime-metrics">
        <article>
          <small>Model parameters</small>
          <strong>
            {evidence?.training?.parameters?.toLocaleString() || "Loading"}
          </strong>
          <span>Includes token embeddings</span>
        </article>
        <article>
          <small>First-attempt generation</small>
          <strong>
            {evidence?.generation
              ? `${evidence.generation.first_pass_accepted} / ${evidence.generation.attempts}`
              : "Pending"}
          </strong>
          <span>Compiled and proved correct</span>
        </article>
        <article>
          <small>Median generation time</small>
          <strong>
            {evidence?.generation
              ? `${evidence.generation.generation_median_ms.toFixed(1)} ms`
              : "Pending"}
          </strong>
          <span>Measured on this computer</span>
        </article>
        <article>
          <small>Matching application calls</small>
          <strong>{demo?.matching_calls?.toLocaleString() || "Pending"}</strong>
          <span>Across changing code and model state</span>
        </article>
      </div>
      {before && after && (
        <div className="runtime-section">
          <h2>Runtime performance</h2>
          <p>
            Native execution removes text parsing and framework overhead.
            PyTorch and NumPy are absent from the runtime package.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Measurement</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Median normal call</td>
                  <td>{before.warm.median_us.toFixed(1)} microseconds</td>
                  <td>{after.warm.median_us.toFixed(1)} microseconds</td>
                </tr>
                <tr>
                  <td>Mean call cost with generation and renewal</td>
                  <td>{before.renewal.amortized_us.toFixed(1)} microseconds</td>
                  <td>{after.renewal.amortized_us.toFixed(1)} microseconds</td>
                </tr>
                <tr>
                  <td>Peak process memory with generation</td>
                  <td>
                    {(before.renewal.peak_process_bytes / 1000000).toFixed(1)}{" "}
                    megabytes
                  </td>
                  <td>
                    {(after.renewal.peak_process_bytes / 1000000).toFixed(1)}{" "}
                    megabytes
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            These values summarize {evidence.optimization.repeats} isolated
            trials on this computer. Each renewal trial uses the same inputs and
            15 replacements.
          </p>
          <p>
            The 256-call lease remains unchanged. New model inference is
            required when decoding material expires.
          </p>
        </div>
      )}
      <div className="runtime-controls">
        <label>
          Generation seed
          <input
            type="number"
            min="1"
            max="10000000"
            value={seed}
            onChange={(event) => setSeed(Number(event.target.value))}
          />
        </label>
        <button
          disabled={
            busy ||
            !evidence?.training ||
            !Number.isInteger(seed) ||
            seed < 1 ||
            seed > 10000000
          }
          onClick={() => void run()}
        >
          {busy ? "Running the virtual machine…" : "Run live runtime check"}
        </button>
        {evidence?.packaged && (
          <a href="/api/runtime/package" className="runtime-download">
            Download runtime package ↗
          </a>
        )}
      </div>
      {demo && (
        <>
          <div className="runtime-section">
            <h2>Model dependence</h2>
            <p>
              Decode material expires after 256 application calls. Each new
              generation requires model inference.
            </p>
            <div className="runtime-checks">
              {Object.entries(demo.attacks).map(
                ([name, result]: [string, any]) => (
                  <article key={name}>
                    <strong>
                      {
                        (
                          {
                            removed: "Model removed",
                            zero: "Model output replaced",
                            replay: "Earlier output replayed",
                            frozen_previous_model: "Earlier model restored",
                          } as Record<string, string>
                        )[name]
                      }
                    </strong>
                    <span
                      className={`tag ${result.blocked ? "lime" : "amber"}`}
                    >
                      {result.blocked ? "EXECUTION BLOCKED" : "CHECK FAILED"}
                    </span>
                  </article>
                ),
              )}
            </div>
          </div>
          <div className="runtime-section">
            <h2>Generated C functions</h2>
            <p>
              These functions came from transformer output. Replacements must
              pass exact unsigned equivalence before installation.
            </p>
            <div className="runtime-code-grid">
              {demo.initial_code.map((item: any, index: number) => (
                <article key={index}>
                  <div className="runtime-code-title">
                    <strong>
                      {["Addition", "Multiplication", "Exclusive OR"][index]}
                    </strong>
                    <span className="tag lime">PROVED</span>
                  </div>
                  <pre>{code(item.code)}</pre>
                </article>
              ))}
            </div>
          </div>
          <div className="runtime-section">
            <h2>Inactive replacements</h2>
            <p>
              Replacement waits when a region has an active call. Model
              evolution waits until all calls finish.
            </p>
            <div className="runtime-code-grid">
              {demo.replacement_code.map((item: any, index: number) => (
                <article key={index}>
                  <div className="runtime-code-title">
                    <strong>Replacement {index + 1}</strong>
                    <span>Seed {item.seed}</span>
                  </div>
                  <pre>{code(item.code)}</pre>
                </article>
              ))}
            </div>
            <p>
              {demo.final.replacements} region replacements completed. The model
              reached generation {demo.final.epoch}.
            </p>
          </div>
          <div className="runtime-section">
            <h2>Measured scope</h2>
            <p>
              The current language supports short C functions with unsigned
              arithmetic. Training covers four transformation families.
            </p>
            <p>
              This package uses native inference and a Python scheduler.
              Physical edge deployment and resistance to independent reverse
              engineering remain unverified.
            </p>
            <p>
              Tests confirm that extracted bytecode can run through a
              replacement interpreter. Model dependence does not establish
              removal resistance.
            </p>
          </div>
        </>
      )}
      {evidence && !evidence.training && (
        <p>
          Run the local model training command to prepare this demonstration.
        </p>
      )}
    </section>
  );
}
