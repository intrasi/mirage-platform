"""Fresh generation checks, native C comparison, and model-size evidence."""
import ctypes
import hashlib
import json
import random
import statistics
import subprocess
import tempfile
import time
import argparse
from pathlib import Path

from compiler import compile_c, execute, prove
from inference import make_generator
from corpus import example


def evaluate(count=90, backend="auto"):
    generator = make_generator(backend=backend)
    rows = []
    valid = []
    generation_times = []
    for index in range(count):
        operation = ["add", "mul", "xor"][index % 3]
        seed = 900000 + index
        begin = time.perf_counter()
        code, prompt = generator.generate(operation, seed)
        generation_times.append((time.perf_counter() - begin) * 1000)
        record = dict(seed=seed, operation=operation, prompt=prompt, code=code)
        try:
            program = compile_c(code)
            record["proof"] = prove(program, operation)
            valid.append((index, program, code, operation))
            record["accepted"] = True
        except Exception as error:
            record.update(accepted=False, reason=str(error))
        rows.append(record)
    with tempfile.TemporaryDirectory(prefix="mirage-native-") as directory:
        source = "#include <stdint.h>\n" + "\n".join(code.replace("region (", f"region_{index} (") for index, _, code, _ in valid)
        path = Path(directory)
        (path / "generated.c").write_text(source)
        subprocess.run(["clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", "generated.c", "-o", "generated.so"], cwd=path, check=True, capture_output=True, timeout=30)
        native = ctypes.CDLL(str(path / "generated.so"))
        rng = random.Random(10000000)
        pairs = [(x, y) for x in [0, 1, 127, 255, 65535, 0x7fffffff, 0x80000000, 0xffffffff]
                 for y in [0, 1, 2, 0x7fffffff, 0x80000000, 0xffffffff]]
        pairs += [(rng.randrange(1 << 32), rng.randrange(1 << 32)) for _ in range(1000)]
        for index, program, _, operation in valid:
            function = getattr(native, f"region_{index}")
            function.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
            function.restype = ctypes.c_uint32
            for x, y in pairs:
                expected = {"add": (x + y) & 0xffffffff, "mul": (x * y) & 0xffffffff, "xor": x ^ y}[operation]
                if function(x, y) != expected or execute(program, x, y) != expected:
                    raise AssertionError("Native C and bytecode differ.")
    training_functions = {example(seed)[1] for seed in range(12000)}
    overlap = sum(code in training_functions for _, _, code, _ in valid)
    report = dict(parameters=generator.parameters, checkpoint_sha256=generator.checkpoint_hash,
                  inference_backend=generator.inference_backend, sampling=generator.sampling,
                  attempts=count, first_pass_accepted=len(valid),
                  distinct_functions=len(set(code for _, _, code, _ in valid)),
                  exact_training_function_matches=overlap,
                  native_checks=len(valid) * len(pairs), compiler="clang -std=c11 -O2 -Wall -Wextra -Werror",
                  generation_median_ms=statistics.median(generation_times),
                  generation_p95_ms=sorted(generation_times)[int(len(generation_times) * 0.95)],
                  generation_times_ms=generation_times, samples=rows,
                  scope="Fresh generation seeds within the same four training families. Exact training matches are counted separately. This is not an unseen-family benchmark.")
    Path("artifacts/generation-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k not in ["samples", "generation_times_ms"]}, indent=2))
    if len(valid) < count * 0.95:
        raise AssertionError("First-pass acceptance is below 95 percent.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["auto", "native", "torch"], default="auto")
    args = parser.parse_args()
    evaluate(backend=args.backend)
