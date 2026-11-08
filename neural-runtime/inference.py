"""Choose a declared inference backend without importing unused frameworks."""
from pathlib import Path


def make_generator(checkpoint=None, backend="auto"):
    if backend not in ["auto", "native", "torch"]:
        raise ValueError("Unknown model backend.")
    native = Path(checkpoint or "artifacts/native-model")
    if backend == "native" or (backend == "auto" and (native / "model.json").exists()
                              and ((native / "model.bin").exists() or (native / "admission.bin").exists())):
        from native_generator import NativeGenerator
        return NativeGenerator(native)
    from generator import Generator
    return Generator(checkpoint or "artifacts/model/model.pt")
