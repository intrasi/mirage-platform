"""Compare native float32 inference with the retained PyTorch reference."""
import hashlib
import json
from pathlib import Path
import random

from generator import Generator
from native_generator import NativeGenerator
from corpus import encode, example


def main():
    reference, native = Generator(), NativeGenerator()
    maximum_logit_error = maximum_hidden_error = 0.0
    positions = 0
    for seed in range(100000, 100032):
        prompt, code = example(seed)
        tokens = encode(prompt + " " + code + " <eos>")
        reference_cache = native_cache = None
        for token in tokens:
            a, reference_cache, ah = reference.forward([token], reference_cache)
            b, native_cache, bh = native.forward([token], native_cache)
            maximum_logit_error = max(maximum_logit_error, max(abs(float(x) - y) for x, y in zip(a, b)))
            maximum_hidden_error = max(maximum_hidden_error, max(abs(float(x) - y) for x, y in zip(ah, bh)))
            positions += 1
        # Check prefill and incremental decoding against the same sequence.
        full, _, full_hidden = native.forward(tokens)
        assert full == b and full_hidden == bh
    assert maximum_logit_error < 0.0001
    assert maximum_hidden_error < 0.0001
    # Use exactly the native sampler with the reference logits for this comparison.
    # This isolates inference changes from the old torch.multinomial sampler.
    expected_sampler = NativeGenerator()
    def reference_forward(ids, cache=None):
        logits, state, hidden = reference.forward(ids, cache)
        return logits.tolist(), state, hidden.tolist()
    expected_sampler.forward = reference_forward
    matches = 0
    for seed in range(900000, 900090):
        operation = ["add", "mul", "xor"][seed % 3]
        expected, _ = expected_sampler.generate(operation, seed)
        actual, _ = native.generate(operation, seed)
        assert expected == actual
        matches += 1
    report = dict(model_checkpoint_sha256=reference.checkpoint_hash, token_positions=positions,
                  maximum_logit_absolute_error=maximum_logit_error, maximum_hidden_absolute_error=maximum_hidden_error,
                  shared_sampler_exact_generations=matches, shared_sampler="python-random-top8-v1",
                  note="Float32 precision is retained. Model-derived keys are backend-specific; packages must be rebuilt when switching inference backend.")
    Path("artifacts/inference-validation.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
