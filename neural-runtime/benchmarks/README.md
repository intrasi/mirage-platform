# Frozen comparison

The baseline files preserve the runtime before harness optimization on 8 November 2026.
They are benchmark inputs, not deployment code.
The fixture contains the same application and helper bytecode for every warm trial.

Each benchmark starts a fresh process.
Each renewal trial uses 4,096 identical inputs, 15 replacements, and 15 model renewals.
The decode lease remains 256 application calls.
Generation, proof, replacement, and renewal time remain inside the measured interval.

Native inference uses a different sampling implementation.
The renewal comparison therefore records every generated source hash and reports its inference backend.
The separate inference check uses one sampler to compare generated text exactly.
