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
from tokenizer import LANGUAGES, SENSITIVE, lex, parser_source


def evaluate(count=90, backend="auto"):
    generator = make_generator(backend=backend)
    rows = []
    valid = []
    generation_times = []
    for index in range(count):
        operation = ["add", "mul", "xor"][index % 3]
        seed = 900000 + index
        begin = time.perf_counter()
        generation_ms = None
        record = dict(seed=seed, operation=operation, language=LANGUAGES[seed % len(LANGUAGES)])
        try:
            code, prompt = generator.generate(operation, seed)
            generation_ms = (time.perf_counter() - begin) * 1000
            record.update(prompt=prompt, code=code)
            program = compile_c(code)
            record["proof"] = prove(program, operation)
            record["function_name"] = program.function_name
            record["requested_language_match"] = any(term in program.function_name for term in SENSITIVE[record["language"]])
            valid.append((index, program, code, operation))
            record["accepted"] = True
        except Exception as error:
            record.update(accepted=False, reason=str(error))
        rows.append(record)
        generation_times.append(generation_ms if generation_ms is not None else (time.perf_counter() - begin) * 1000)
    with tempfile.TemporaryDirectory(prefix="mirage-native-") as directory:
        # Compile actual Unicode names. ASCII wrappers provide portable ctypes lookup.
        functions = []
        for index, program, code, _ in valid:
            name = f"{program.function_name}_{index}"
            functions.append(" ".join([*lex(code)[:1], name, *lex(code)[2:]]))
            functions.append(f"uint32_t region_{index}(uint32_t x,uint32_t y){{return {name}(x,y);}}")
        source = "#include <stdint.h>\n" + "\n".join(functions)
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
    normalized_training = {parser_source(code)[0] for code in training_functions}
    normalized_generated = [parser_source(code)[0] for _, _, code, _ in valid]
    report = dict(parameters=generator.parameters, checkpoint_sha256=generator.checkpoint_hash,
                  inference_backend=generator.inference_backend, sampling=generator.sampling,
                  attempts=count, first_pass_accepted=len(valid),
                  distinct_functions=len(set(code for _, _, code, _ in valid)),
                  exact_training_function_matches=overlap,
                  distinct_code_after_identifier_normalization=len(set(normalized_generated)),
                  training_matches_after_identifier_normalization=sum(code in normalized_training for code in normalized_generated),
                  tokenizer_version=getattr(generator, "tokenizer_version", "legacy-v1"),
                  language_matches=sum(row.get("requested_language_match", False) for row in rows),
                  languages={language: dict(attempts=sum(row["language"] == language for row in rows),
                                            accepted=sum(row["language"] == language and row["accepted"] for row in rows),
                                            naming_matches=sum(row["language"] == language and row.get("requested_language_match", False) for row in rows)) for language in LANGUAGES},
                  native_checks=len(valid) * len(pairs), compiler="clang -std=c11 -O2 -Wall -Wextra -Werror",
                  generation_median_ms=statistics.median(generation_times),
                  generation_p95_ms=sorted(generation_times)[int(len(generation_times) * 0.95)],
                  generation_times_ms=generation_times, samples=rows,
                  scope="Fresh generation seeds within the same four training families. Exact training matches are counted separately. This is not an unseen-family benchmark.")
    Path("artifacts/generation-report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k not in ["samples", "generation_times_ms"]}, indent=2))
    if len(valid) < count * 0.95:
        raise AssertionError("First-pass acceptance is below 95 percent.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["auto", "native", "torch"], default="auto")
    args = parser.parse_args()
    evaluate(backend=args.backend)
