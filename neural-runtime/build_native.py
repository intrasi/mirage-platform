"""Build the small native execution backend for this Python and processor."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sysconfig
import argparse


def build(sanitize=False):
    root = Path(__file__).resolve().parent
    output = root / ("_mirage_native" + sysconfig.get_config_var("EXT_SUFFIX"))
    temporary = output.with_suffix(output.suffix + ".tmp")
    flags = ["-O3", "-std=c11", "-shared", "-fPIC", "-Wall", "-Wextra", "-Werror", "-Wno-missing-field-initializers", "-Wno-deprecated-declarations"]
    if platform.system() == "Darwin":
        flags += ["-undefined", "dynamic_lookup", "-framework", "Accelerate"]
    if sanitize:
        flags += ["-O1", "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-sanitize-recover=all"]
    args = [os.environ.get("CC", "clang"), *flags, "-I" + sysconfig.get_paths()["include"], str(root / "native_vm.c"), "-o", str(temporary)]
    if platform.system() != "Darwin":
        args += ["-lcrypto", "-lblas", "-lm"]
    subprocess.run(args, check=True, timeout=60)
    temporary.replace(output)
    report = dict(path=str(output), bytes=output.stat().st_size, sha256=hashlib.sha256(output.read_bytes()).hexdigest(),
                  source_sha256=hashlib.sha256((root / "native_vm.c").read_bytes()).hexdigest(),
                  platform=platform.platform(), flags=flags)
    (root / "artifacts").mkdir(exist_ok=True)
    (root / "artifacts/native-build.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sanitize", action="store_true")
    build(parser.parse_args().sanitize)
