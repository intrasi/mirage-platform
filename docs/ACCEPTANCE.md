# First-release acceptance

The local workflow passes its execution checks, but the complete release gate remains incomplete.
This record covers the requirements dated 8 November 2026.

| Requirement | Result | Evidence or dependency |
|---|---|---|
| Public repository intake | Passed | Live GitHub download, immutable commit, verified Git blobs, SHA-256 snapshot, dependency manifest inventory |
| Repository execution isolation | Not executed | No hosted sandbox is configured; imported repository instructions remain disabled |
| Reproducible baseline | Passed locally | Two independent compilation directories produce identical binaries |
| Baseline safety | Passed locally | CBMC checks the original function and declared arithmetic domain |
| Device intake | Passed | Versioned schema, persistent registry, per-field provenance, separate capability states |
| Custom hardware files | Passed | Private uploads, content identities, review state, explicit file references, authenticated downloads |
| Unsupported hardware | Passed | Missing board, processor, toolchain, peripheral, energy, and runtime capabilities block dependent checks |
| Bounded search | Passed locally | Candidate, duration, token, spending, and repeated-failure limits; recorded stopping reason |
| Recovery | Passed locally | Worker restart preserves the baseline, prior candidates, elapsed accounting, and durable deadline |
| Gate independence | Passed within the restricted catalog | Provider output selects a typed transformation; it cannot alter source contracts or policy |
| Incorrect candidate rejection | Passed | The injected behavior change produces a CBMC counterexample |
| Proof reporting | Passed | Unsupported, timeout, and failed proof states cannot produce acceptance |
| Device resource limits | Passed for accepted native candidates | Absolute binary, memory, batch-time, and relative slowdown gates |
| Required model policy | Passed as capability rejection | The native build adapter cannot ship the separate runtime package |
| Unchanged baseline return | Passed | Rejected candidates produce a labeled baseline export without a protection claim |
| Evidence identity | Passed | Source, binary, profile, policy, compiler, and package identities match downloaded artifacts |
| Reproducible transformations | Passed locally | Accepted sources rebuild identically in separate directories |
| Authentication and access | Passed for one workspace | Unauthorized API and artifact requests fail; no multi-customer isolation claim |
| Reconstruction | Passed locally | Original, conventional, selected, and packaged neural runtime variants each pass 1,240 independent judge inputs |
| Reconstruction benefit | Failed | The procedural analyst recovered all four variants |
| Genuine model proposals | Not executed | No approved application endpoint, credential, model, and pricing configuration |
| Model reconstruction | Fixture passed; live check not executed | Provider adapter and frozen-program judge are implemented; application credentials are absent |
| Hosted Linux execution | Not executed | No private Linux worker endpoint or credentials; Docker daemon is unavailable |
| Hosted image identity | Contract implemented; deployment not executed | The service requires an immutable worker image digest |
| Local runtime inference | Passed | The 764,544-parameter transformer generates replacements inside the custom virtual-machine harness |
| Runtime correctness | Passed | Nineteen runtime tests, 90 matching reference generations, and 94,320 native comparisons |
| Runtime removal controls | Passed within stated scope | Basic removal and replay controls fail; extracted instructions remain usable without the model |
| Browser workflow | Passed | Four workflows cover runtime inference, setup, rejection, acceptance, fresh inputs, cancellation, baseline return, and downloads |
| Mobile layout | Passed | No horizontal overflow in the checked runtime and baseline-return screens |
| Export | Passed | Separate source, executable, patch, manifest, human report, and complete private developer bundle |
| Retention and deletion | Passed locally | Terminal run deletion, artifact reference checks, and seven-day cleanup |
| Physical hardware | Later scope | A named board adapter, runner, fixtures, and measurements are required |

The twenty platform tests include provider and hosted-protocol fixtures.
Those fixtures do not establish a live external model call or a hosted deployment.

The reconstruction analyst searches a restricted arithmetic family.
It receives public observations and freezes its result before judge inputs exist.
The model analyst additionally receives a bounded release-disassembly excerpt.
Neither analyst establishes resistance to general reverse engineering.

The local runtime comparison uses the verified distributed runtime package.
It does not insert that package into the accepted native executable.
The native package and runtime package retain separate identities and resource evidence.

## Reproduction

```sh
npm run typecheck
npm test
npm run test:browser
npm run verify:sample
npm run verify:intake
npm run runtime:test
npm run format:check
```

Use `npm run dev` to start the application.
Use `npm run token` to obtain the local access code.
Run `npm run test:http` against that service for live event-stream and archive checks.

Latest local evidence:

- `.data/completion-verification.json`: complete sample result.
- `.data/completion-runtime-tests.log`: runtime tests and generation comparison.
- `.data/intake-verification/snapshot.json`: live public repository snapshot.
- `.data/completion-http/smoke-result.json`: live HTTP checks and downloaded artifact identities.
- `.data/browser/`: desktop and mobile screenshots and downloaded packages.
- `.data/browser-report/`: browser test report.
