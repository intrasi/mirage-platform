import argparse
import copy
import json
import random
import resource
import statistics
import sys
import time
from pathlib import Path

from compiler import Program, execute
from inference import make_generator
from runtime import VirtualMachine


def application():
    # Compile the sample call graph into the custom instruction set.
    return Program((
        ("LOAD", 0), ("CONST", 38171), ("CALL", 2), ("STORE", 3),
        ("LOAD", 3), ("CONST", 38171), ("CALL", 2), ("LOAD", 1), ("CALL", 1),
        ("CONST", 128), ("CALL", 0), ("CONST", 8), ("SHR", 0),
        ("LOAD", 2), ("CALL", 0), ("CLAMP", 4095), ("RETURN", 0),
    ), 4)


def reference(raw, gain, offset):
    return max(0, min(4095, ((raw * gain + 128) >> 8) + offset))


def create(seed=100000, on_event=None, model_backend="auto", vm_backend="auto"):
    generator = make_generator(backend=model_backend)
    candidates = [generator.candidate(operation, seed + i) for i, operation in enumerate(["add", "mul", "xor"])]
    vm = VirtualMachine(generator, {**{i: c["program"] for i, c in enumerate(candidates)}, 3: application()}, seed, on_event, backend=vm_backend)
    return vm, candidates


def demonstrate(seed=100000, rounds=3, count=1000):
    vm, initial = create(seed)
    generator = vm.generator
    started = time.perf_counter()
    inputs = [(x, g, o) for x in [0, 1, 127, 128, 4094, 4095]
              for g in [1, 128, 256, 1024] for o in [-1024, -1, 0, 1, 1024]]
    rng = random.Random(seed + 800000)
    inputs.extend((rng.randrange(4096), rng.randrange(1, 1025), rng.randrange(-1024, 1025)) for _ in range(count))
    matches, timings, replacement_code = 0, [], []
    snapshots = [vm.snapshot()]
    try:
        for iteration in range(rounds):
            for values in inputs:
                begin = time.perf_counter_ns()
                actual = vm.run(*values)
                timings.append((time.perf_counter_ns() - begin) / 1e6)
                if actual != reference(*values):
                    raise AssertionError(f"Runtime mismatch for {values}.")
                matches += 1
            # The application can continue during model generation.
            future = vm.regenerate_async(iteration % 3, seed + 50000 + iteration)
            for values in inputs[:16]:
                if vm.run(*values) != reference(*values):
                    raise AssertionError("Output changed during background generation.")
            replacement_code.append({k: v for k, v in future.result(timeout=30).items() if k != "program"})
            vm.rotate()
            snapshots.append(vm.snapshot())
        # Exercise the final evolved model and newly installed regions.
        for values in inputs[:120]:
            if vm.run(*values) != reference(*values):
                raise AssertionError("Output changed after the final rotation.")
        attacks = {}
        for fault in ["removed", "zero", "replay"]:
            # Existing material remains valid until renewal. Test that boundary
            # without deleting cached keys or native argument tuples.
            vm.calls_in_lease = vm.lease_calls
            generator.fault = fault
            generator.replay = None
            try:
                vm.run(812, 300, -21)
                attacks[fault] = {"blocked": False}
            except Exception as error:
                attacks[fault] = {"blocked": True, "reason": str(error)}
            finally:
                generator.fault = None
        old_state = generator.representation()
        vm.rotate()
        current_state = generator.representation()
        try:
            generator.set_representation(old_state)
            vm.calls_in_lease = vm.lease_calls
            vm.run(812, 300, -21)
            attacks["frozen_previous_model"] = {"blocked": False}
        except Exception as error:
            attacks["frozen_previous_model"] = {"blocked": True, "reason": str(error)}
        finally:
            generator.set_representation(current_state)
            vm.keys.clear()
        if not all(row["blocked"] for row in attacks.values()):
            raise AssertionError("A model dependence control failed.")
        if vm.run(812, 300, -21) != 931:
            raise AssertionError("Restored model failed.")
        extracted = {i: vm.restore(region) for i, region in vm.regions.items()}
        def unprotected_call(region, x, y):
            return execute(extracted[region], x, y, invoke=unprotected_call)
        plain_vm_timings = []
        reference_timings = []
        for raw, gain, offset in inputs:
            begin = time.perf_counter_ns()
            execute(extracted[3], raw, gain, invoke=unprotected_call, extra=(offset & 0xffffffff,))
            plain_vm_timings.append((time.perf_counter_ns() - begin) / 1e6)
            begin = time.perf_counter_ns()
            reference(raw, gain, offset)
            reference_timings.append((time.perf_counter_ns() - begin) / 1e6)
        report = dict(parameters=generator.parameters, model_sha256=generator.checkpoint_hash,
                      inference_backend=generator.inference_backend, sampling=generator.sampling,
                      language="restricted C with uint32_t arithmetic", initial_code=[{k: v for k, v in c.items() if k != "program"} for c in initial],
                      replacement_code=replacement_code, snapshots=snapshots, attacks=attacks,
                      matching_calls=matches, background_checks=rounds * 16, post_rotation_checks=120,
                      median_call_ms=statistics.median(timings), p95_call_ms=sorted(timings)[int(len(timings) * 0.95)],
                      unprotected_vm_median_ms=statistics.median(plain_vm_timings),
                      plain_python_median_ms=statistics.median(reference_timings),
                      lifecycle_slowdown=statistics.median(timings) / statistics.median(plain_vm_timings),
                      elapsed_ms=(time.perf_counter() - started) * 1000,
                      process_peak_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024),
                      checkpoint_bytes=Path("artifacts/model/model.pt").stat().st_size,
                      generation_rejections=generator.rejections, final=vm.snapshot(), events=list(vm.events),
                      limits=["Native CPU inference is verified on the development computer; physical edge deployment is not verified.",
                              "Generation covers three unsigned arithmetic operations and four training families.",
                              "Weights change through an exact representation transformation, not online learning.",
                              "Model-derived decoding material is cached for one bytecode generation.",
                              "An analyst can extract decoded bytecode and build an independent interpreter."])
        return report, vm
    except Exception:
        vm.close()
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=100000)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--count", type=int, default=1000)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report, vm = demonstrate(args.seed, args.rounds, args.count)
    vm.close()
    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/demo-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report if args.json else {k: report[k] for k in ["parameters", "matching_calls", "median_call_ms", "p95_call_ms", "attacks", "final", "limits"]}, indent=2))
