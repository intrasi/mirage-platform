# Small generative runtime

The working model contains 764,544 parameters and generates short C functions locally.

The model starts from [Dusty-8M-Base](https://huggingface.co/mkhordoo/dusty-8m-base).
The pinned revision is `193c3f0845038d2d801c00885c8bcec33e383e18`.
The downloaded checkpoint contains 7,868,672 parameters.
Structured pruning retains four layers, complete attention heads, and 128 hidden dimensions.
The code vocabulary contains 166 tokens.
All parameters then receive supervised C post-training.
The training script records source hashes, dimensions, seeds, losses, and completed steps.

The transformer implementation comes from [DustyLM](https://github.com/khordoo/dusty-lm/tree/7a624c91611daa06580bb9104d52e8013c47e114).
`LICENSE.dusty` preserves its MIT notice.
The runtime does not import the synthetic corpus or use a procedural generation fallback.

## Run

From the platform directory:

```sh
npm run runtime:setup
npm run runtime:train
npm run runtime:test
npm run runtime:demo
npm run runtime:package
npm run dev
```

The setup command requires `uv` and Python 3.12.
The training command selects Apple Metal when available.
Runtime inference uses a native float32 transformer on the central processing unit.
PyTorch is required for training and export, but the deployment package does not import it.
Use `npm run runtime:build` to rebuild native code and export an existing trained checkpoint.
Use `npm run runtime:benchmark` to repeat the isolated comparison.
All model operations run locally after the initial checkpoint download.

The default web screen displays the runtime demonstration.
The live button runs new model generation and application checks.
The download contains native inference, a native interpreter, a Python scheduler, encoded bytecode, and three model shards.
The packaged binary targets this computer's operating system, processor, and Python 3.12 application binary interface.
The old native C build workflow remains a separate comparison.

## Execution

1. The transformer generates a complete unsigned C function, one token at a time.
2. The restricted compiler converts the function into custom stack bytecode.
3. Z3 proves exact equivalence across every pair of 32-bit unsigned inputs.
4. The scheduler installs the accepted replacement only when its region is inactive.
5. The transformer derives decoding material from region identity, generation, and execution history.
6. The interpreter restores bytecode for a call and drops that decoded buffer after return.
7. After 256 application calls, the harness renews model-derived decoding material.
8. The scheduler also requests another generated replacement in the background.

The supported C subset contains two unsigned inputs, initialized unsigned locals, arithmetic, constant shifts, and one final return.
The learned operations are addition, multiplication, and exclusive OR.
The training corpus contains four transformation families.
The calibration application calls all three generated helpers through custom bytecode.
This compiler does not accept arbitrary C repositories.

Model evolution changes one final-normalization sign and the matching output-projection column.
This operation preserves generation logits exactly.
It changes the hidden state that supplies decoding material.
The virtual machine reseals dormant code before it resumes execution.
This is representation evolution, not online training.

The package splits weights into admission, scheduler, and dispatch files.
This demonstrates distribution across harness components.
No experiment establishes that this distribution makes reverse engineering harder.

## Evidence

| Check | Observed result |
|---|---|
| Model parameters, including embeddings | 764,544 |
| Float32 checkpoint | 3,067,408 bytes |
| First-attempt native generation | 90 accepted functions from 90 attempts |
| Distinct accepted functions | 89 |
| Accepted functions identical to training text | 10 |
| Native C and bytecode comparisons | 94,320 matching outputs |
| Median native generation time | About 2.4 milliseconds per function |
| Lifecycle and native execution tests | 19 passed, including address and undefined-behavior sanitizer runs |
| Packaged target | 600 matching calls across automatic renewal |

These are measurements from the development computer.
Generation inputs use new random seeds within the training families.
The generation report counts exact matches with training functions separately.
This does not measure generalization to unseen transformation families.

## Harness optimization

The native harness reduces normal-call time by 16.2 times against the frozen Python baseline.
The complete generation and renewal cycle reduces average call cost by 4.3 times.

| Measurement | Frozen baseline | Optimized harness |
|---|---:|---:|
| Median normal call | 109.67 microseconds | 6.75 microseconds |
| Average call cost including generation, proof, replacement, and renewal | 172.92 microseconds | 39.76 microseconds |
| Peak process memory during the complete cycle | 267.45 megabytes | 80.89 megabytes |
| Peak process memory without generation or proof | 238.09 megabytes | 35.47 megabytes |

Peak process memory during the complete cycle falls by about 70 percent.
These values are medians across three isolated trials per configuration on this macOS ARM64 computer.
Each normal-call trial executes 12,000 identical inputs against identical frozen bytecode.
Each renewal trial executes 4,096 identical inputs with 15 replacements and 15 renewals.
The decoding lease remains 256 calls.
Generation and proof remain inside the renewal measurement.
Request latency samples and percentiles remain separate for each trial.

Packed binary instructions replace repeated text parsing.
The native interpreter authenticates and decodes each activated region into temporary storage.
It clears decoded instructions after execution.
No persistent decoded-code cache is used.
The harness reuses decoding material produced during sealing within the existing lease.
Fresh model inference authenticates existing regions before renewal.
Detailed tracing uses the Python diagnostic interpreter.
The frozen baseline includes detailed tracing, while the native production measurement excludes it.

Native inference retains all 764,544 float32 parameters.
The native sampler differs from the original PyTorch sampler.
Renewal trials therefore produce equivalent functions that can have different source text.
A separate shared-sampler check produced identical text for all 90 native and PyTorch generation pairs.
Inference validation compared 1,260 token positions with a maximum absolute logit difference below 0.00001.
Decoding material is backend-specific; rebuilding a package prevents mixing incompatible encodings.

The package does not import PyTorch or NumPy.
It still requires Python and the Z3 proof solver.
Linux execution and physical edge timing, memory, and power remain unverified.

Generated evidence lives under `artifacts/`:

- `model/training.json`: training provenance and actual parameter count.
- `generation-report.json`: every sampled function, rejection, proof, and generation time.
- `demo-report.json`: application checks, runtime transitions, timing, memory, and model-dependence controls.
- `package-report.json`: package identity and standalone execution result.
- `optimization/report.json`: isolated before-and-after trials, raw request latency, source hashes, and output identities.
- `inference-validation.json`: native inference agreement with the trained reference model.
- `mirage-neural-runtime.tar.gz`: the runnable target package.

## Model-dependence limits

Removing the model blocks the next decoding-material renewal.
Existing material remains valid for the current lease.
Zero output, replayed output, and an earlier model state cannot decode newly sealed regions in the tested controls.

An analyst can still intercept decoded instructions and replace the interpreter.
The test suite contains a successful extraction control.
The implementation therefore establishes operational model dependence, not an unremovable model or a demonstrated protection advantage.

The source generator and lifecycle implementation now exist.
Physical edge integration, wider C coverage, and independent reconstruction experiments remain separate required work.
