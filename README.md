# Mirage platform

Mirage now runs a 764,544-parameter generative transformer inside a custom virtual-machine demonstration.
The model generates C functions and replaces inactive bytecode regions during application execution.
Model-derived values decode real application instructions.
Model representation and dormant bytecode evolve together.

The optimized harness uses native inference and native bytecode execution.
Normal calls are 16.2 times faster than the frozen Python baseline on this computer.
The full generation and renewal cycle is 4.3 times faster and uses about 70 percent less peak process memory.
The 256-call decoding lease remains unchanged.

The default interface opens the runtime model demonstration.
It shows generated functions, exact equivalence checks, runtime replacement, model-dependence tests, and a downloadable package.

```sh
npm run runtime:setup
npm run runtime:train
npm run runtime:test
npm run runtime:demo
npm run runtime:package
npm run dev
```

Training downloads one pinned pretrained checkpoint and runs locally.
No paid provider or cloud worker is required.
See [runtime implementation and limits](neural-runtime/README.md).

The earlier native C build workflow remains available under Protection setup.
Its hosted release still needs a hosted Linux worker and a genuine provider-model run.

The interface accepts a sample project, target profile, resource limits, and protection settings.
The worker transforms a calibration function, proves output equivalence, and measures the compiled executable.
It delivers source changes, an executable package, and private evidence.

This project is separate from the earlier image prototype.

## Start

Use Node.js 24 or later, Clang, and the standard command-line build tools.

```sh
git clone git@github.com:mrsladoje/mirage-platform.git
cd mirage-platform
npm ci
npm run setup:proof
npm run dev
```

The interface normally opens at `http://127.0.0.1:4183`.
The launcher selects another free port when necessary.
Run `npm run token` in another terminal to read the local workspace access code.
Enter that code in the interface.

The proof installer supports macOS ARM64.
It checks pinned CBMC and Z3 downloads before extraction.
For another host, set `CBMC_PATH` and `Z3_BIN_DIR` to installed tools.

Choose the included sample and the native development profile.
Select catalog mode, then start the protection run.
The result page includes proof logs, executable measurements, live input comparison, and downloads.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the interface and service. |
| `npm run build` | Compile the service and build the frontend. |
| `npm start` | Serve the production build on the loopback address. |
| `npm test` | Run real proof, compiler, API, persistence, and export checks. |
| `npm run verify:sample` | Execute the full sample workflow in separate verification storage. |
| `npm run sample:repo` | Generate an independent local sample Git repository. |
| `npm run typecheck` | Check frontend and service types. |
| `npm run test:browser` | Run the authored Playwright browser workflows. |
| `npm run format:check` | Check source formatting. |
| `npm run verify:intake` | Verify a public GitHub source snapshot through live requests. |
| `npm run schema:profile` | Regenerate the device profile JSON schema. |

Browser tests require Chromium. Install it with `npx playwright install chromium` when needed.
All four browser workflows passed after the first-release completion work.
Desktop and mobile runtime screenshots are available under `.data/browser/`.

## Architecture

```text
React interface
    │ authenticated requests and event stream
Fastify service ── SQLite records and private artifact store
    │ persistent queue and worker lease
Bounded search controller
    ├── catalog proposals or configured model provider
    ├── typed transformation tools
    ├── independent CBMC and Z3 proof
    ├── compiler, executable comparison, and resource measurements
    ├── reconstruction analysis with frozen hypotheses
    └── source archive, patch, executable, manifest, and evidence
```

Public repository intake now downloads immutable source snapshots and verifies each Git blob.
The service records dependency manifests without executing repository instructions.

The product specification exposes timing, memory, storage, energy, slowdown, token, cost, and repeated-failure limits.
Missing device capabilities block a run before execution.
Required device models remain unavailable in the native build adapter.
The separate runtime demonstration provides local model inference.

A run with no accepted candidate returns the unchanged baseline.
The interface identifies that outcome and records the stopping reason.
Source, executable, human-readable report, and private developer evidence downloads remain separate.

The model selects transformations through a restricted schema.
It cannot change the frozen contract or acceptance limits.
Failed, incomplete, and timed-out checks cannot produce accepted candidates.

The service stores metadata in SQLite.
Artifacts use SHA-256 content identities and authenticated download identifiers.
Worker leases prevent concurrent job execution in the same workspace.
Interrupted jobs retain evidence and resume from recorded checkpoints.

The current local executor runs only the trusted calibration sample.
The hosted worker adapter uses the same proof and build interfaces.
The supplied hosted worker also restricts execution to the trusted catalog.
General repository execution requires a separate reviewed isolation and build adapter.

## Scope and evidence

The reference function accepts raw readings from 0 to 4095.
The Q8 gain ranges from 1 to 1024. The offset ranges from −1024 to 1024.
CBMC checks exact output equivalence across this complete declared domain.
The harness also checks arithmetic safety and applicable memory properties.

Source proof does not prove compiler correctness.
Each accepted binary therefore passes 10,000 generated inputs and 240 boundary cases.
The worker also measures executable size, peak memory, and repeated calculation batches.
It rejects transformations that disappear from the compiled function.

The current reconstruction analyst queries each real executable.
It searches a declared arithmetic family, freezes its answer, and then receives fresh judge cases.
The analyst recovered the original, conventional, selected, and neural-runtime variants.
This result establishes no protection benefit against this analyst.
General and model-based reverse engineering resistance remain unmeasured.

The generated executable is an unsigned demonstration package for its declared operating system and processor.
It is not firmware for a toothbrush or another physical board.
Uploaded profiles and hardware files are recorded for review.
They do not automatically create a hardware simulator.

## External integrations

The `.env.example` file lists configuration names.
Export values in the service environment; the application does not load that file automatically.

Model mode requires an approved HTTPS chat-completions endpoint, model identifier, credential, and token prices.
The customer must permit source disclosure in the protection policy.
The reconstruction analyst can use the same provider through a constrained arithmetic program contract.
That analyst receives release disassembly and public observations, without private source or judge answers.
The service reserves the maximum estimated request cost before sending a proposal request.
Failed requests retain that reservation when actual usage is unavailable.
Provider contract tests use explicit fixtures. They are not live model evidence.

See [the hosted worker instructions](docs/HOSTED_WORKER.md) for the private worker contract and image.
No hosted deployment or paid model call was made during implementation.
The native C build workflow includes no model in its executable.
The separate runtime package includes the small transformer, custom interpreter, and encoded application bytecode.

The default retention period is seven days.
Retention removes expired run artifacts and unused attachments at service startup.
Downloaded copies remain under the customer's control.

## Project records

- [Product requirements](docs/PRD.md)
- [Implementation decisions](docs/IMPLEMENTATION_DECISIONS.md)
- [Implementation status and remaining checks](docs/IMPLEMENTATION_STATUS.md)
- [Hosted worker setup](docs/HOSTED_WORKER.md)
- [Device profile format](docs/DEVICE_PROFILES.md)
- [First-release acceptance matrix](docs/ACCEPTANCE.md)

The editable product requirements remain at https://chatgpt.com/space/page_8ed29204773c8191ab78b4ef7444cac1.
