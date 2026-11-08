# Implementation decisions

## 1. Preserve the earlier prototype
- Question: Where does the platform belong?
- Choice: Use a separate `mirage-platform` directory.
- Reason: The existing image prototype has separate work and tests.
- Alternatives: Replace the prototype.
- Files: This project only.
- Verification: Inspect the sibling directory without changes.
- Reversibility: Remove this independent project.
- Priority: Informational.

## 2. Native development when hosted execution is unavailable
- Question: Which execution environment can run now?
- Choice: Use the trusted sample on macOS ARM64. Keep Linux x86-64 and hosted execution separate.
- Reason: Docker has no running daemon. No sandbox credentials exist in the environment.
- Alternatives: Purchase a service or start unrelated machine services.
- Files: Worker, target profiles, sandbox adapter, interface.
- Verification: Record platform identity and test rejection of unsupported targets.
- Reversibility: Configure a hosted worker later.
- Priority: Required follow-up.

## 3. Model access and safe transformation boundary
- Question: Can the application call an external model now?
- Choice: Implement an OpenAI-compatible provider and deterministic catalog mode. Label catalog results clearly.
- Reason: The application has no configured model credentials. Chat access does not supply application credentials.
- Alternatives: Extract another application's credentials or report fixture proposals as agent output.
- Files: Model adapter, transformation catalog, worker, interface.
- Verification: Provider contract tests and explicit capability reporting.
- Reversibility: Set provider configuration after authorization.
- Priority: Required follow-up.
- The model selects typed transformations. It cannot write arbitrary files or alter the acceptance policy.

## 4. Project-local proof tool
- Question: How can formal verification run on this host?
- Choice: Download the pinned Homebrew CBMC 6.11.0 bottle into `.tools`, then verify its SHA-256.
- Reason: This bottle supports the current host and has no additional runtime dependencies.
- Alternatives: A Linux image, global installation, or tests without proof.
- Files: Proof installer and verifier.
- Verification: Execute relational proofs and an intentionally incorrect control.
- Reversibility: Delete the project-local tool directory.
- Priority: Informational.

## 5. Performance measurement
- Question: How can small functions have stable measurements?
- Choice: Measure repeated 10000-call batches inside each executable. Use median batch time and process peak memory.
- Reason: Process startup would dominate a single function call.
- Alternatives: Time each invocation through the network.
- Files: Trusted executable runner and performance gate.
- Verification: Record raw samples, platform units, baseline ratio, and absolute limits.
- Reversibility: Introduce a new policy version and rerun.
- Priority: Useful refinement.

## 6. Formal solver backend
- Question: How can complete proofs finish within the existing time limit?
- Choice: Keep CBMC and use the Z3 backend.
- Reason: The default solver timed out on valid transformations. Z3 proved the unchanged obligations in milliseconds.
- Alternatives: Increase the limit or reduce the proof obligations.
- Files: Executor, process environment, proof installer, worker image.
- Verification: The same complete domain passes. The incorrect control still produces a counterexample.
- Reversibility: Change the backend and rerun all proof checks.
- Priority: Informational.
- CBMC remains version 6.11.0. Native Z3 is version 5.3.3 with a checked archive digest.

## 7. Reconstruction without an analyst model
- Question: What real reconstruction experiment can run without model credentials?
- Choice: Use a procedural analyst with access only to executable input and output.
- Reason: This produces a measured result without inventing a model response.
- Alternatives: Leave analysis empty or provide a fabricated transcript.
- Files: Reconstruction module, worker, candidate interface.
- Verification: Freeze each hypothesis before generating 1,000 judge inputs and 240 boundary cases.
- Reversibility: Add another analyst through the same artifact and budget contract.
- Priority: Required follow-up.
- The analyst recovered the original, conventional, and selected builds.
- The product reports no demonstrated benefit against this analyst.

## 8. Browser verification access
- Question: How can the interface receive visual verification in this session?
- Choice: Supply executable browser tests and record visual verification as incomplete.
- Reason: The computer-control tool reported no browser connection. Native Chrome access timed out twice.
- Alternatives: Claim an unobserved result or bypass the available computer-control mechanism.
- Files: Browser tests, browser configuration, implementation status.
- Verification: Browser test discovery succeeds. Real HTTP tests cover the service workflow and downloads.
- Reversibility: Run the browser tests when browser access becomes available.
- Priority: Required follow-up.

## 9. Dependency maintenance
- Question: Which package versions can be used safely with this scaffold?
- Choice: Update affected packages to compatible versions with no reported audit findings.
- Reason: The initial versions had published dependency advisories.
- Alternatives: Keep the earlier versions or change the stack.
- Files: Package manifest and lockfile.
- Verification: Production build, type checks, integration tests, and npm audit.
- Reversibility: Restore the lockfile only with equivalent checks.
- Priority: Informational.

## 10. Durable accounting and export time
- Question: What happens when a worker stops during a model request or reaches its time budget?
- Choice: Persist cost reservations before network requests. Reserve part of the duration for analysis and export.
- Reason: A restart must not erase possible model charges or restart the elapsed-time allowance.
- Alternatives: Account only after successful responses or reset the allowance after recovery.
- Files: Model provider, worker checkpoints, recovery tests.
- Verification: Failed provider fixtures retain reservations. Restart tests retain baseline evidence and elapsed time.
- Reversibility: Introduce another explicit policy version.
- Priority: Informational.

## 11. Separate verification storage
- Question: How can command-line verification coexist with the running demonstration service?
- Choice: Use `.data/verification` for the standalone verification command.
- Reason: Direct verification must not compete with the service worker for the same run directory.
- Alternatives: Require the service to stop before every check.
- Files: Package scripts and isolated integration fixtures.
- Verification: Standalone verification and service tests use separate databases and artifact directories.
- Reversibility: Route all checks through the service later.
- Priority: Informational.
