# Implementation status

The missing local first-release workflows are implemented and tested.
The complete hosted release remains incomplete.
The tested reconstruction analyst still recovers the protected calculation.

## Completed in this update

- Public GitHub intake now downloads immutable file content and verifies each Git blob.
- Source snapshots include dependency manifest identities and authenticated downloads.
- Device uploads persist in a versioned registry with per-field provenance.
- Capability checks reject unknown hardware, required device models, and unavailable energy measurements before execution.
- The interface exposes timing, memory, storage, slowdown, energy, token, spending, and failure limits.
- Protection settings include explicit function selection, exclusions, and external source-disclosure permission.
- Baseline and candidate builds reproduce in separate compilation directories.
- Baseline proof checks precede candidate acceptance.
- Tool records include project identity, frozen hashes, budgets, duration, results, and failure evidence.
- Worker recovery retains a durable deadline and completed evidence.
- Runs with no accepted transformation export the unchanged baseline with a clear outcome.
- Accepted candidates retain their measured resource tradeoffs.
- Original, procedural, selected, and neural-runtime artifacts use the same local reconstruction analyst.
- A configured model can reconstruct constrained arithmetic programs through the provider adapter.
- Private developer bundles include proof inputs, logs, source snapshots, model transcripts, and artifact indexes.
- Human-readable reports include resource measurements, candidate decisions, proof assumptions, and reconstruction results.
- Recorded events and runtime reports carry replay labels.
- Runtime requests use persistent idempotency records and preserve their own downloadable evidence.
- Run deletion and retention remove expired artifact references.
- Hosted requests retry busy responses within a fixed bound.
- Hosted execution records the declared image digest and cancels work when the client disconnects.

## Current verification

| Check | Result |
|---|---|
| Frontend and service type checks | Passed |
| Production build | Passed |
| Platform test suite | 20 tests passed |
| Browser suite | 4 workflows passed |
| Runtime unit suite | 19 tests passed |
| Reference and native generation | 90 matching generations |
| Native output comparisons | 94,320 comparisons passed |
| Sample protection search | Three accepted candidates; incorrect control rejected |
| Public repository source intake | Live download passed |
| Live HTTP workflow | Event stream, fresh inputs, and archive inspection passed |
| Formatting | Passed |

Provider and hosted-protocol tests use explicit fixtures.
They are separate from the real local compiler, proof, runtime, and browser checks.

The sample verification run is `be224ac4-be50-4a19-b1ca-941cc3fc2ff1`.
Its execution target is macOS ARM64.
Each of the four reconstruction variants matched all 1,240 held-out judge inputs.
This establishes no protection benefit against the tested analyst.

The earlier runtime optimization remains available.
Its model contains 764,544 parameters and supports restricted unsigned C arithmetic.
Its Python scheduler controls native inference, proof checks, region replacement, and decoding renewal.
The deployment package does not require PyTorch or NumPy.
These results do not establish physical edge performance.

See [the complete acceptance matrix](ACCEPTANCE.md) for each release requirement.

## Unresolved dependencies and failed acceptance

1. Genuine external model execution requires an approved endpoint, credential, model identifier, and token prices.
2. Hosted Linux execution requires a private worker, an enclosing isolation boundary, credentials, and an exact image digest.
3. The Docker daemon is unavailable, so the hosted image build has not executed here.
4. The neural protection-benefit condition fails against the current procedural analyst.
5. General repository execution remains disabled until a reviewed isolation and build adapter exists.
6. Physical board execution remains later scope in the product requirements.

The separate local runtime package does not satisfy hosted Linux acceptance.
A passing fixture does not satisfy genuine model execution.
A successful reconstruction comparison does not imply a protection benefit.

## Continue

```sh
npm run dev
npm run token
```

Use the runtime screen for local transformer execution.
Use Protection setup for the native source, proof, measurement, and export workflow.
The accepted native executable contains no runtime model.

Reproduction commands and evidence paths appear in [the acceptance matrix](ACCEPTANCE.md).
The [decision log](IMPLEMENTATION_DECISIONS.md) records scope and implementation choices.
The [hosted worker guide](HOSTED_WORKER.md) describes the remaining deployment action.
