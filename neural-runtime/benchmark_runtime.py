"""Isolated before/after benchmarks with fixed inputs and renewal schedules."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import resource
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "artifacts/optimization"
BASELINE = ROOT / "benchmarks/baseline"


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "programs.json").write_bytes((ROOT / "benchmarks/programs.json").read_bytes())


def child(variant, workload):
    sys.path.insert(0, str(BASELINE if variant == "baseline" else ROOT))
    from compiler import Program
    from runtime import VirtualMachine
    if variant in ["baseline", "native-vm-torch"]:
        from generator import Generator
        generator = Generator(ROOT / "artifacts/model/model.pt")
    else:
        from native_generator import NativeGenerator
        generator = NativeGenerator(ROOT / "artifacts/native-model")
    fixture = (OUT / "programs.json").read_bytes()
    programs = {int(i): Program(tuple(tuple(w) for w in p["words"]), p["registers"]) for i, p in json.loads(fixture).items()}
    vm = VirtualMachine(generator, programs, seed=55221, automatic=False,
                        lease_calls=256 if workload == "renewal" else 1000000)
    rng = random.Random(734210)
    count = 4096 if workload == "renewal" else 12000
    inputs = [(rng.randrange(4096), rng.randrange(1, 1025), rng.randrange(-1024, 1025)) for _ in range(count)]
    # A fixed warmup covers material acquisition. Renewal measurements include all later material work.
    for i in range(32):
        vm.run(*inputs[i])
    vm.calls_in_lease = 0
    latencies, results, replacements = [], [], []
    start = time.perf_counter_ns()
    try:
        for i, values in enumerate(inputs):
            begin = time.perf_counter_ns()
            if workload == "renewal" and i and i % 256 == 0:
                candidate = vm.regenerate((i // 256) % 3, 800000 + i // 256)
                replacements.append(dict(code_sha256=hashlib.sha256(candidate["code"].encode()).hexdigest(), attempts=candidate["attempts"]))
            results.append(vm.run(*values))
            latencies.append((time.perf_counter_ns() - begin) / 1000)
        elapsed = (time.perf_counter_ns() - start) / 1e9
        expected = [max(0, min(4095, ((x * y + 128) >> 8) + z)) for x, y, z in inputs]
        assert results == expected
        assert vm.epoch == (15 if workload == "renewal" else 0)
        assert vm.replacements == (15 if workload == "renewal" else 0)
        sorted_latencies = sorted(latencies)
        code_root = BASELINE if variant == "baseline" else ROOT
        sources = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(code_root.glob("*.py"))}
        if variant != "baseline":
            sources["native_vm.c"] = hashlib.sha256((ROOT / "native_vm.c").read_bytes()).hexdigest()
        report = dict(variant=variant, workload=workload, calls=count,
                      median_us=statistics.median(latencies), p95_us=sorted_latencies[int(count * 0.95)],
                      p99_us=sorted_latencies[int(count * 0.99)], max_us=max(latencies),
                      elapsed_seconds=elapsed, amortized_us=elapsed * 1e6 / count,
                      peak_process_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024),
                      epochs=vm.epoch, replacements=replacements, matching_outputs=count,
                      model_calls=generator.forward_calls, generation_ms=generator.generation_ms, material_ms=generator.key_ms,
                      torch_imported="torch" in sys.modules,
                      model_checkpoint_sha256=generator.checkpoint_hash,
                      fixture_sha256=hashlib.sha256(fixture).hexdigest(),
                      inputs_sha256=hashlib.sha256(json.dumps(inputs).encode()).hexdigest(),
                      outputs_sha256=hashlib.sha256(json.dumps(results).encode()).hexdigest(),
                      source_hashes=sources, latency_us=latencies)
        print(json.dumps(report))
    finally:
        vm.close()


def main(repeats):
    if not (BASELINE / "runtime.py").exists():
        raise RuntimeError("The frozen pre-optimization package is missing.")
    subprocess.run([sys.executable, __file__, "--prepare"], check=True, cwd=ROOT)
    records = []
    variants = ["baseline", "native-vm-torch", "native-vm-native-model"]
    # Rotate order to reduce warm-machine and thermal ordering effects.
    for repeat in range(repeats):
        for workload in ["warm", "renewal"]:
            order = variants[repeat % 3:] + variants[:repeat % 3]
            for variant in order:
                result = subprocess.run([sys.executable, __file__, "--child", variant, "--workload", workload],
                                        check=True, capture_output=True, text=True, cwd=ROOT, timeout=60)
                row = json.loads(result.stdout)
                row["repeat"] = repeat
                records.append(row)
                print(json.dumps({k: row[k] for k in ["variant", "workload", "median_us", "amortized_us", "peak_process_bytes"]}), flush=True)
    summary = {}
    for variant in variants:
        summary[variant] = {}
        for workload in ["warm", "renewal"]:
            rows = [r for r in records if r["variant"] == variant and r["workload"] == workload]
            summary[variant][workload] = {key: statistics.median(r[key] for r in rows) for key in ["median_us", "amortized_us", "peak_process_bytes"]}
    for workload in ["warm", "renewal"]:
        inputs = {r["inputs_sha256"] for r in records if r["workload"] == workload}
        outputs = {r["outputs_sha256"] for r in records if r["workload"] == workload}
        assert len(inputs) == len(outputs) == 1
    report = dict(protocol="Identical closed-loop input traces; 256-call material leases; 15 explicit replacements and rotations in each renewal trial. Generation and proof time are included.",
                  caveats=["Warm trials use exactly the same frozen application bytecode.",
                           "Renewal trials use the same prompts and replacement schedule; native sampling produces different equivalent functions.",
                           "Detailed per-frame tracing is enabled in the old baseline and disabled in native production execution.",
                           "Summary values are medians across isolated trials. Request percentiles remain in each trial and are not pooled.",
                           "Whole-process peak memory includes proof, model, and runtime in each fresh process."],
                  repeats=repeats, summary=summary, trials=records)
    (OUT / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--child", choices=["baseline", "native-vm-torch", "native-vm-native-model"])
    parser.add_argument("--workload", choices=["warm", "renewal"], default="warm")
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if args.prepare:
        prepare()
    elif args.child:
        child(args.child, args.workload)
    else:
        main(args.repeats)
