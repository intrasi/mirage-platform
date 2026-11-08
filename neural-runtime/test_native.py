import hashlib
import hmac
import json
from pathlib import Path
import random
import unittest

import _mirage_native
from compiler import Program, compile_c, execute
from runtime import stream


def image(programs, mutation=None):
    key = bytes(range(32))
    rows = []
    for i, program in enumerate(programs):
        raw = program.pack()
        if mutation is not None and i == 3:
            raw = mutation(raw)
        cipher = stream(raw, key)
        rows.append((cipher, hmac.digest(key, cipher, "sha256")))
    return _mirage_native.prepare(tuple(rows)), (key,) * 4


class NativeVMTests(unittest.TestCase):
    def test_generated_programs_match_reference_interpreter(self):
        report = json.loads(Path("artifacts/generation-report.json").read_text())
        rng = random.Random(445)
        values = [0, 1, 31, 32, 255, 0x7fffffff, 0x80000000, 0xffffffff]
        cases = [(x, y) for x in values for y in values] + [(rng.randrange(1 << 32), rng.randrange(1 << 32)) for _ in range(1000)]
        main = Program((("LOAD", 0), ("LOAD", 1), ("CALL", 0), ("RETURN", 0)), 3)
        for row in report["samples"]:
            if not row["accepted"]:
                continue
            program = compile_c(row["code"])
            handle, keys = image([program, program, program, main])
            for x, y in cases:
                value, depth = _mirage_native.run(handle, keys, x, y, 0)
                self.assertEqual(value, execute(program, x, y))
                self.assertEqual(depth, 2)

    def test_corrupted_ciphertext_fails_and_does_not_poison_next_call(self):
        helper = compile_c("uint32_t region(uint32_t x,uint32_t y){return x+y;}")
        main = Program((("LOAD", 0), ("LOAD", 1), ("CALL", 0), ("RETURN", 0)), 3)
        handle, keys = image([helper, helper, helper, main])
        with self.assertRaisesRegex(RuntimeError, "cannot decode"):
            _mirage_native.run(handle, (bytes(32),) * 4, 1, 2, 0)
        self.assertEqual(_mirage_native.run(handle, keys, 1, 2, 0), (3, 2))

    def test_authenticated_malformed_bytecode_is_bounded(self):
        helper = compile_c("uint32_t region(uint32_t x,uint32_t y){return x+y;}")
        main = Program((("LOAD", 0), ("LOAD", 1), ("CALL", 0), ("RETURN", 0)), 3)
        mutations = [lambda raw: b"BAD!" + raw[4:],
                     lambda raw: raw[:4] + bytes([255]) + raw[5:],
                     lambda raw: raw[:8] + bytes([255]) + raw[9:],
                     lambda raw: raw[:8] + bytes([3]) + raw[9:],
                     lambda raw: raw[:-1]]
        for mutation in mutations:
            handle, keys = image([helper, helper, helper, main], mutation)
            with self.assertRaises(RuntimeError):
                _mirage_native.run(handle, keys, 1, 2, 0)

    def test_native_import_does_not_import_tensor_frameworks(self):
        import subprocess
        import sys
        import os
        script = "from native_generator import NativeGenerator; import sys; g=NativeGenerator(); g.candidate('add',100000); assert 'torch' not in sys.modules; assert 'numpy' not in sys.modules"
        environment = dict(os.environ)
        if environment.get("ASAN_OPTIONS") and sys.platform == "darwin":
            # macOS can remove DYLD variables during interpreter startup.
            environment["DYLD_INSERT_LIBRARIES"] = subprocess.check_output(
                ["clang", "-print-file-name=libclang_rt.asan_osx_dynamic.dylib"], text=True).strip()
        subprocess.run([sys.executable, "-c", script], check=True, timeout=20, env=environment)

    def test_authenticated_random_corruption_stays_bounded(self):
        helper = compile_c("uint32_t region(uint32_t x,uint32_t y){return x+y;}")
        main = Program((("LOAD", 0), ("LOAD", 1), ("CALL", 0), ("RETURN", 0)), 3)
        rng = random.Random(92361)
        for _ in range(1000):
            position, value = rng.randrange(len(main.pack())), rng.randrange(256)
            def mutate(raw):
                changed = bytearray(raw)
                changed[position] = value
                return bytes(changed)
            handle, keys = image([helper, helper, helper, main], mutate)
            try:
                value, depth = _mirage_native.run(handle, keys, 1, 2, 0)
                self.assertTrue(0 <= value <= 0xffffffff and 1 <= depth <= 4)
            except RuntimeError:
                pass


if __name__ == "__main__":
    unittest.main()
