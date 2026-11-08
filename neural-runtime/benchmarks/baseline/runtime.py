"""Custom VM with model-derived decoding and inactive-region replacement."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import base64
import hashlib
import hmac
import json
import secrets
import threading

from compiler import Program, execute, validate


def stream(raw, key):
    output = bytearray()
    for start in range(0, len(raw), 32):
        block = hashlib.sha256(key + (start // 32).to_bytes(4, "little")).digest()
        output.extend(a ^ b for a, b in zip(raw[start:start + 32], block))
    return bytes(output)


@dataclass
class Region:
    context: bytes
    ciphertext: bytes
    tag: bytes
    version: int = 0
    active: int = 0


class VirtualMachine:
    def __init__(self, generator, programs=None, seed=1, on_event=None, lease_calls=256, automatic=True):
        self.generator = generator
        self.regions = {}
        self.epoch = 0
        self.history = hashlib.sha256(str(seed).encode()).digest()
        self.keys = {}
        self.lock = threading.RLock()
        self.model_lock = threading.RLock()
        self.pending = {}
        self.events = []
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
        self.events = self.events[-256:]
        if self.on_event:
            self.on_event(event, self)

    def seal(self, region, program, version):
        validate(program)
        context = json.dumps(dict(region=region, version=version, epoch=self.epoch,
                                  history=self.history.hex()), sort_keys=True).encode()
        with self.model_lock:
            material = self.generator.material(context)
        plaintext = program.pack()
        ciphertext = stream(plaintext, material)
        return Region(context, ciphertext, hmac.digest(material, ciphertext, "sha256"), version)

    def restore(self, region):
        key = self.keys.get(region.context)
        if key is None:
            with self.model_lock:
                key = self.generator.material(region.context)
            self.keys[region.context] = key
        if not hmac.compare_digest(hmac.digest(key, region.ciphertext, "sha256"), region.tag):
            raise RuntimeError("Model output cannot decode this bytecode generation.")
        return Program.unpack(stream(region.ciphertext, key))

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
            self.event("enter", region, version=installed.version)
            program = self.restore(installed)
            self.event("decoded", region, instructions=len(program.words))
            result = execute(program, x & 0xffffffff, y & 0xffffffff,
                             invoke=lambda target, a, b: self.call(target, a, b), extra=extra)
            return result
        finally:
            # The only durable installed buffer is ciphertext. No decoded region cache.
            program = None
            with self.lock:
                installed.active -= 1
                self.event("leave", region, version=installed.version)
                if region in self.pending:
                    self.install(region, self.pending.pop(region))
                if self.rotation_pending and not any(r.active for r in self.regions.values()):
                    self.rotate()

    def run(self, raw, gain, offset):
        if any(type(v) is not int for v in [raw, gain, offset]) or not (0 <= raw <= 4095 and 1 <= gain <= 1024 and -1024 <= offset <= 1024):
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
        result = self.call(3, raw, gain, (offset & 0xffffffff,))
        with self.lock:
            self.history = hashlib.sha256(self.history + result.to_bytes(4, "little")).digest()
        return result

    def install(self, region, candidate):
        with self.lock:
            current = self.regions[region]
            if current.active:
                self.pending[region] = candidate
                self.event("deferred", region)
                return False
            replacement = self.seal(region, candidate["program"], current.version + 1)
            self.regions[region] = replacement
            self.keys.pop(current.context, None)
            self.replacements += 1
            self.event("replace", region, version=replacement.version,
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
                previous_epoch = self.epoch
                self.epoch += 1
                self.generator.evolve(self.epoch)
                try:
                    replacements = {i: self.seal(i, program, self.regions[i].version + 1) for i, program in programs.items()}
                except Exception:
                    self.generator.evolve(self.epoch)
                    self.epoch = previous_epoch
                    raise
                self.regions = replacements
                self.keys.clear()
                self.calls_in_lease = 0
                self.rotation_pending = False
                self.event("evolve", changed_parameters="final normalization and matching output projection column")
                return True

    def snapshot(self):
        with self.lock:
            return dict(epoch=self.epoch, replacements=self.replacements, maximum_active=self.maximum_active,
                        parameters=self.generator.parameters, model_calls=self.generator.forward_calls,
                        generation_ms=self.generator.generation_ms, decode_model_ms=self.generator.key_ms,
                        regions=[dict(id=i, version=r.version, active=r.active, bytes=len(r.ciphertext),
                                      fingerprint=hashlib.sha256(r.ciphertext).hexdigest()) for i, r in self.regions.items()])

    def export_payload(self):
        with self.lock:
            if any(r.active for r in self.regions.values()):
                raise RuntimeError("Cannot export active regions.")
            return dict(epoch=self.epoch, history=self.history.hex(), regions={str(i): {
                "context": base64.b64encode(r.context).decode(), "ciphertext": base64.b64encode(r.ciphertext).decode(),
                "tag": r.tag.hex(), "version": r.version} for i, r in self.regions.items()})

    def import_payload(self, payload):
        with self.lock:
            if self.regions:
                raise RuntimeError("Import requires an empty VM.")
            self.epoch = payload["epoch"]
            self.history = bytes.fromhex(payload["history"])
            self.regions = {int(i): Region(base64.b64decode(r["context"]), base64.b64decode(r["ciphertext"]),
                                         bytes.fromhex(r["tag"]), r["version"]) for i, r in payload["regions"].items()}

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=True)
        self.keys.clear()
        self.closed = True
