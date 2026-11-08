"""Custom VM with model-derived decoding and inactive-region replacement."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
import base64
import hashlib
import hmac
import json
import secrets
import threading
from collections import deque

try:
    import _mirage_native
except ImportError:
    _mirage_native = None

from compiler import Program, execute, validate


def stream(raw, key):
    output = bytearray()
    for start in range(0, len(raw), 32):
        block = hashlib.sha256(key + (start // 32).to_bytes(4, "little")).digest()
        part = raw[start:start + 32]
        output.extend((int.from_bytes(part, "little") ^ int.from_bytes(block[:len(part)], "little")).to_bytes(len(part), "little"))
    return bytes(output)


@dataclass
class Region:
    context: bytes
    ciphertext: bytes
    tag: bytes
    version: int = 0
    active: int = 0
    function_name: str | None = None
    symbols: tuple = ()


class MaterialCache(dict):
    """Version cached material so native argument tuples never survive invalidation."""
    def __init__(self):
        super().__init__()
        self.revision = 0

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        self.revision += 1

    def clear(self):
        super().clear()
        self.revision += 1

    def pop(self, *args):
        value = super().pop(*args)
        self.revision += 1
        return value

    def update(self, *args, **kwargs):
        super().update(*args, **kwargs)
        self.revision += 1


class VirtualMachine:
    def __init__(self, generator, programs=None, seed=1, on_event=None, lease_calls=256, automatic=True, backend="auto", trace=False):
        if backend not in ["auto", "native", "python"]:
            raise ValueError("Unknown execution backend.")
        if backend == "native" and _mirage_native is None:
            raise RuntimeError("Build the native backend with build_native.py.")
        if type(lease_calls) is not int or lease_calls < 1:
            raise ValueError("The decode lease must contain at least one application call.")
        self.backend = "native" if backend != "python" and _mirage_native is not None else "python"
        self.trace = trace
        self.native_image = None
        self.generator = generator
        self.regions = {}
        self.epoch = 0
        self.history = hashlib.sha256(str(seed).encode()).digest()
        self.keys = MaterialCache()
        self.native_materials = None
        self.native_material_revision = -1
        self.lock = threading.RLock()
        self.model_lock = threading.RLock()
        self.pending = {}
        self.events = deque(maxlen=256)
        self.on_event = on_event
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mirage-generator")
        self.closed = False
        self.maximum_active = 0
        self.replacements = 0
        self.rotation_pending = False
        self.lease_calls = lease_calls
        self.calls_in_lease = 0
        self.automatic = automatic
        self.background = None
        if programs:
            for region, program in programs.items():
                self.regions[region] = self.seal(region, program, 0)

    def event(self, action, region=None, **details):
        event = dict(action=action, region=region, epoch=self.epoch,
                     active={str(k): r.active for k, r in self.regions.items() if r.active}, **details)
        self.events.append(event)
        if self.on_event:
            self.on_event(event, self)

    def seal(self, region, program, version, material_out=None):
        validate(program)
        context = json.dumps(dict(region=region, version=version, epoch=self.epoch,
                                  history=self.history.hex()), sort_keys=True).encode()
        with self.model_lock:
            material = self.generator.material(context)
        plaintext = program.pack()
        ciphertext = stream(plaintext, material)
        if material_out is not None:
            material_out[context] = material
        return Region(context, ciphertext, hmac.digest(material, ciphertext, "sha256"), version,
                      function_name=program.function_name, symbols=program.symbols)

    def restore(self, region):
        key = self.keys.get(region.context)
        if key is None:
            with self.model_lock:
                key = self.generator.material(region.context)
            self.keys[region.context] = key
        if not hmac.compare_digest(hmac.digest(key, region.ciphertext, "sha256"), region.tag):
            raise RuntimeError("Model output cannot decode this bytecode generation.")
        return replace(Program.unpack(stream(region.ciphertext, key)), function_name=region.function_name, symbols=region.symbols)

    def call(self, region, x, y, extra=()):
        with self.lock:
            if self.closed:
                raise RuntimeError("The VM is closed.")
            installed = self.regions[region]
            if installed.active:
                raise RuntimeError("Concurrent or recursive entry is not supported.")
            installed.active += 1
            self.maximum_active = max(self.maximum_active, sum(r.active for r in self.regions.values()))
        program = None
        try:
            if self.trace or self.on_event:
                self.event("enter", region, version=installed.version, function_name=installed.function_name)
            program = self.restore(installed)
            if self.trace or self.on_event:
                self.event("decoded", region, instructions=len(program.words), function_name=installed.function_name, symbols=installed.symbols)
            result = execute(program, x & 0xffffffff, y & 0xffffffff,
                             invoke=lambda target, a, b: self.call(target, a, b), extra=extra)
            return result
        finally:
            # The only durable installed buffer is ciphertext. No decoded region cache.
            program = None
            with self.lock:
                installed.active -= 1
                if self.trace or self.on_event:
                    self.event("leave", region, version=installed.version)
                if region in self.pending:
                    self.install(region, self.pending.pop(region))
                if self.rotation_pending and not any(r.active for r in self.regions.values()):
                    self.rotate()

    def run(self, raw, gain, offset):
        if type(raw) is not int or type(gain) is not int or type(offset) is not int or not (0 <= raw <= 4095 and 1 <= gain <= 1024 and -1024 <= offset <= 1024):
            raise ValueError("Input exceeds the calibration domain.")
        with self.lock:
            if self.background is not None and self.background.done():
                try:
                    self.background.result()
                except Exception as error:
                    self.event("generation-rejected", reason=str(error))
                self.background = None
            if self.calls_in_lease >= self.lease_calls:
                self.rotate()
                if self.automatic and self.background is None:
                    seed = int.from_bytes(self.history[:4], "little")
                    self.background = self.regenerate_async(self.epoch % 3, seed)
            self.calls_in_lease += 1
        if self.backend == "native" and not self.trace and self.on_event is None:
            result = self.native_call(raw, gain, offset)
        else:
            # Detailed callbacks use the instrumented reference interpreter.
            result = self.call(3, raw, gain, (offset & 0xffffffff,))
        with self.lock:
            self.history = hashlib.sha256(self.history + result.to_bytes(4, "little")).digest()
        return result

    def native_call(self, raw, gain, offset):
        with self.lock:
            if self.closed:
                raise RuntimeError("The VM is closed.")
            if any(region.active for region in self.regions.values()):
                raise RuntimeError("Concurrent or recursive entry is not supported.")
            if self.native_image is None:
                self.native_image = _mirage_native.prepare(tuple((self.regions[i].ciphertext, self.regions[i].tag) for i in range(4)))
            if self.native_material_revision != self.keys.revision:
                materials = []
                for i in range(4):
                    context = self.regions[i].context
                    material = self.keys.get(context)
                    if material is None:
                        with self.model_lock:
                            material = self.generator.material(context)
                        self.keys[context] = material
                    materials.append(material)
                self.native_materials = tuple(materials)
                self.native_material_revision = self.keys.revision
            main = self.regions[3]
            main.active = 1
            try:
                result, maximum = _mirage_native.run(self.native_image, self.native_materials, raw, gain, offset & 0xffffffff)
                self.maximum_active = max(self.maximum_active, maximum)
                return result
            finally:
                main.active = 0

    def install(self, region, candidate):
        with self.lock:
            current = self.regions[region]
            if current.active:
                self.pending[region] = candidate
                self.event("deferred", region)
                return False
            prepared = {}
            replacement = self.seal(region, candidate["program"], current.version + 1, prepared)
            self.regions[region] = replacement
            self.native_image = None
            self.keys.pop(current.context, None)
            self.keys.update(prepared)
            self.replacements += 1
            self.event("replace", region, version=replacement.version,
                       function_name=replacement.function_name, symbols=replacement.symbols,
                       fingerprint=hashlib.sha256(replacement.ciphertext).hexdigest(),
                       code=candidate["code"], proof=candidate["proof"])
            return True

    def regenerate(self, region, seed):
        if region not in [0, 1, 2]:
            raise ValueError("Only generated helper regions can be replaced.")
        operation = ["add", "mul", "xor"][region]
        # Model mutation and generation share a lock. Application bytecode can execute.
        with self.model_lock:
            candidate = self.generator.candidate(operation, seed)
        self.install(region, candidate)
        return candidate

    def regenerate_async(self, region, seed):
        if self.closed:
            raise RuntimeError("The VM is closed.")
        return self.pool.submit(self.regenerate, region, seed)

    def rotate(self):
        with self.lock:
            if any(r.active for r in self.regions.values()):
                self.rotation_pending = True
                self.event("rotation-deferred")
                return False
            with self.model_lock:
                programs = {i: self.restore(region) for i, region in self.regions.items()}
                # Require fresh current-model inference on two distinct existing capsules.
                # A zero or stale output must not become the key for the next generation.
                for i in [0, 3]:
                    region = self.regions[i]
                    probe = self.generator.material(region.context)
                    if not hmac.compare_digest(hmac.digest(probe, region.ciphertext, "sha256"), region.tag):
                        raise RuntimeError("Model output cannot renew this bytecode generation.")
                previous_epoch = self.epoch
                self.epoch += 1
                self.generator.evolve(self.epoch)
                try:
                    prepared = {}
                    replacements = {i: self.seal(i, program, self.regions[i].version + 1, prepared) for i, program in programs.items()}
                except Exception:
                    self.generator.evolve(self.epoch)
                    self.epoch = previous_epoch
                    raise
                self.regions = replacements
                self.native_image = None
                self.keys.clear()
                self.keys.update(prepared)
                self.calls_in_lease = 0
                self.rotation_pending = False
                self.event("evolve", changed_parameters="final normalization and matching output projection column")
                return True

    def snapshot(self):
        with self.lock:
            return dict(epoch=self.epoch, replacements=self.replacements, maximum_active=self.maximum_active,
                        backend=self.backend, instrumented=bool(self.trace or self.on_event),
                        parameters=self.generator.parameters, model_calls=self.generator.forward_calls,
                        generation_ms=self.generator.generation_ms, decode_model_ms=self.generator.key_ms,
                        regions=[dict(id=i, version=r.version, active=r.active, bytes=len(r.ciphertext),
                                      function_name=r.function_name, symbols=r.symbols,
                                      fingerprint=hashlib.sha256(r.ciphertext).hexdigest()) for i, r in self.regions.items()])

    def inspection(self):
        """Public names for the installed versions, without source or key material."""
        with self.lock:
            return dict(format="mirage-public-symbols-v1", epoch=self.epoch,
                        regions=[dict(region=i, version=r.version, function_name=r.function_name,
                                      symbols=list(r.symbols), ciphertext_sha256=hashlib.sha256(r.ciphertext).hexdigest())
                                 for i, r in sorted(self.regions.items())])

    def export_payload(self):
        with self.lock:
            if any(r.active for r in self.regions.values()):
                raise RuntimeError("Cannot export active regions.")
            return dict(format="mvm2", inference_backend=getattr(self.generator, "inference_backend", "torch-float32"),
                        epoch=self.epoch, history=self.history.hex(), regions={str(i): {
                "context": base64.b64encode(r.context).decode(), "ciphertext": base64.b64encode(r.ciphertext).decode(),
                "tag": r.tag.hex(), "version": r.version, "function_name": r.function_name,
                "symbols": list(r.symbols)} for i, r in self.regions.items()})

    def import_payload(self, payload):
        with self.lock:
            if self.regions:
                raise RuntimeError("Import requires an empty VM.")
            expected = payload.get("inference_backend", "torch-float32")
            if expected != getattr(self.generator, "inference_backend", "torch-float32"):
                raise ValueError("Payload and inference backend differ. Rebuild the package.")
            if payload.get("format") != "mvm2":
                self.backend = "python"
            self.epoch = payload["epoch"]
            self.history = bytes.fromhex(payload["history"])
            self.regions = {int(i): Region(base64.b64decode(r["context"]), base64.b64decode(r["ciphertext"]),
                                         bytes.fromhex(r["tag"]), r["version"],
                                         function_name=r.get("function_name"), symbols=tuple(r.get("symbols", []))) for i, r in payload["regions"].items()}
            self.native_image = None

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=True)
        self.keys.clear()
        self.native_image = None
        self.native_materials = None
        self.closed = True
