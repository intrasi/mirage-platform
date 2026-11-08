# Implementation status

The native local demonstration works. The complete hosted agent release is not yet verified.

## Milestones

| Milestone | State | Completed work | Remaining dependency |
|---|---|---|---|
| Sample and frontend | Implemented; visual verification incomplete | Calculator, profile intake, resource settings, run interface, candidate evidence, live comparison, downloads | Working browser access |
| Agent and independent proof | Local proof passed; live model incomplete | Typed transformations, provider adapter, durable budgets, CBMC and Z3, negative control, strict acceptance | Approved application model endpoint and credential |
| Hosted execution and delivery | Native workflow passed; hosted workflow incomplete | Private worker protocol, container recipe, durable jobs, recovery, cancellation, exports, authentication | Isolated hosted Linux x86-64 worker and private HTTPS endpoint |
| Reconstruction and model assessment | Procedural analysis passed; model analysis incomplete | Real executable queries, frozen hypotheses, fresh judge inputs, declared device assessment | Model analyst and measured device runtime |

No physical device or on-device model was included.
General repository execution remains disabled.
The GitHub connector records public commit and tree metadata.

## Verified local checks

- The production build and frontend/service type checks passed.
- Fourteen automated tests passed.
- CBMC rejected an intentionally incorrect transformation with a counterexample.
- CBMC proved accepted transformations across the complete declared input domain.
- The accepted binary matched 10,000 generated inputs and 240 boundary cases.
- The release function retained a compiled transformation.
- Executable size, peak memory, batch timing, and relative slowdown passed the configured limits.
- Authentication, origin checks, input validation, and artifact identity checks passed.
- Idempotency conflicts and exclusive worker leases passed.
- Active cancellation prevented successful packaging.
- Worker recovery preserved the baseline artifact and resumed incomplete verification.
- Retention preserved shared artifacts needed by active runs.
- A real HTTP event stream delivered ordered run events.
- Source and executable downloads matched their manifests.
- The downloaded executable produced 931 for input `812 300 -21`.
- The original, conventional, and selected builds each passed all 1,240 reconstruction judge cases.
- Live GitHub metadata intake resolved `octocat/Hello-World` at commit `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`.
- Dependency audit reported no vulnerabilities.

Provider tests use explicit fixtures. Hosted protocol tests do not constitute a hosted deployment.

## Local result

Verified run: `cc7d17f5-3a8e-4f0f-9a7d-d73c76f297bc`.
Target: macOS ARM64, reported internally as `darwin-arm64`.
Proof tools: CBMC 6.11.0 and Z3 5.3.3.

| Measurement | Observed value |
|---|---|
| Executable size | 34,008 bytes |
| Peak process memory | 1,376,256 bytes |
| Median 10,000-call batch | 0.02028 milliseconds |
| Slowdown against the matching baseline | 1.77 times |
| Executable comparisons | 10,240 matching inputs |
| Streamed run events | 23 events |

These measurements describe one host run. They are not customer device guarantees.
The reconstruction result establishes no protection benefit against this narrow analyst.

The complete machine-readable result is `.data/smoke-result.json`.
Downloaded packages and their inspected contents are in `.data/demo-export`.
The independent sample Git repository is in `.data/sample-repository`.

## Checks not executed

| Check | Reason | Next executable action |
|---|---|---|
| Visual browser workflow | Browser connection unavailable; native Chrome access timed out | Install Chromium if needed, then run `npm run test:browser` |
| Genuine model proposal | No application model configuration | Set the approved provider configuration and select model mode |
| Hosted Linux x86-64 execution | No running Linux worker or hosted access | Deploy the prepared worker privately, then select the Linux target |
| Hosted image build | Docker client exists, but its daemon is unavailable | Build `deploy/Dockerfile.worker` on the intended Linux host |
| Model reconstruction comparison | No configured analyst model | Add the approved analyst provider and retain the same evaluation budgets |
| Physical hardware behavior | No board adapter or physical hardware | Implement a named device adapter and its executable model |

The browser suite contains two discovered workflows. It has not been run in a browser.
The first covers target selection, proof failures, candidate inspection, fresh inputs, downloads, and viewport screenshots.
The second covers cancellation and reload persistence.

## Continue implementation

Use `npm run dev` to start the interface and service.
Use `npm run token` to read the local access code.
Use `npm run test:http` to repeat the live service and download checks.
Use `npm run verify:sample` to repeat the sample workflow in isolated verification storage.

The next external action is a real model run or hosted worker connection.
Do not report those requirements as complete until their evidence exists.
