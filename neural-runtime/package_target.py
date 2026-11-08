import hashlib
import json
import platform
import shutil
import subprocess
import sys
import sysconfig
import tarfile
import tempfile
from pathlib import Path

from demo import create


def main():
    artifacts = Path("artifacts")
    artifacts.mkdir(exist_ok=True)
    vm, _ = create(model_backend="native", vm_backend="native")
    try:
        vm.rotate()
        vm.rotate()
        with tempfile.TemporaryDirectory(prefix="package-", dir=artifacts) as temporary:
            target = Path(temporary) / "target"
            target.mkdir()
            shards = vm.generator.export_shards(target / "weights")
            (target / "payload.json").write_text(json.dumps(vm.export_payload(), indent=2))
            for name in ["native_generator.py", "inference.py", "compiler.py", "runtime.py", "run.py", "native_vm.c", "build_native.py", "LICENSE.dusty"]:
                shutil.copyfile(name, target / name)
            extension = "_mirage_native" + sysconfig.get_config_var("EXT_SUFFIX")
            shutil.copyfile(extension, target / extension)
            shutil.copyfile("requirements-runtime.lock", target / "requirements.lock")
            (target / "README.txt").write_text(
                "Install Python 3.12 dependencies from requirements.lock.\n"
                "Run: python run.py 812 300 -21\n"
                "Expected output: 931\n"
                "This package includes a native extension for the platform in manifest.json.\n"
                "It does not require PyTorch or NumPy.\n"
                "Send repeated input lines to keep the virtual machine active.\n"
                "The model regenerates inactive regions and renews decoding material after 256 calls.\n"
                "Physical edge deployment is not verified.\n")
            manifest = dict(parameters=vm.generator.parameters, base="mkhordoo/dusty-8m-base",
                            revision="193c3f0845038d2d801c00885c8bcec33e383e18", license="MIT (see LICENSE.dusty)",
                            model_shards=shards, epoch=vm.epoch, inference_backend=vm.generator.inference_backend,
                            target=platform.platform(), python_abi=sysconfig.get_config_var("SOABI"),
                            files={str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(target.rglob("*")) if p.is_file()})
            (target / "manifest.json").write_text(json.dumps(manifest, indent=2))
            check = subprocess.run([sys.executable, "run.py"], cwd=target, input="812 300 -21\n" * 600,
                                   capture_output=True, text=True, timeout=30, check=True)
            if check.stdout.splitlines() != ["931"] * 600:
                raise AssertionError("Exported target failed across lease renewals.")
            # Assert successful generation, not only cached execution, in the exported package.
            probe = """import json,sys
from inference import make_generator
from runtime import VirtualMachine
g=make_generator('weights'); vm=VirtualMachine(g,backend='native')
vm.import_payload(json.load(open('payload.json')))
for i in range(600): assert vm.run(812,300,-21)==931
vm.close()
assert vm.epoch >= 4 and vm.replacements >= 1
assert 'torch' not in sys.modules and 'numpy' not in sys.modules
print(json.dumps({'epoch':vm.epoch,'replacements':vm.replacements,'torch_imported':False,'numpy_imported':False}))
"""
            state = subprocess.run([sys.executable, "-c", probe], cwd=target, capture_output=True, text=True, timeout=30, check=True)
            archive = artifacts / "mirage-neural-runtime.tar.gz"
            with tarfile.open(archive, "w:gz") as bundle:
                for file in target.rglob("*"):
                    if file.is_file() and "__pycache__" not in str(file):
                        bundle.add(file, arcname="mirage-runtime/" + str(file.relative_to(target)))
            destination = artifacts / "target"
            if destination.exists():
                shutil.rmtree(destination)
            shutil.copytree(target, destination, ignore=shutil.ignore_patterns("__pycache__"))
            result = dict(path=str(archive), bytes=archive.stat().st_size,
                          sha256=hashlib.sha256(archive.read_bytes()).hexdigest(), standalone_matching_calls=600,
                          native_verification=json.loads(state.stdout), target=manifest["target"], python_abi=manifest["python_abi"])
            (artifacts / "package-report.json").write_text(json.dumps(result, indent=2))
            print(json.dumps(result, indent=2))
    finally:
        vm.close()


if __name__ == "__main__":
    main()
