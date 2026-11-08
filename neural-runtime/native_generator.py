"""Local float32 transformer inference without PyTorch or NumPy imports."""
import hashlib
import heapq
import json
import math
from pathlib import Path
import random
import struct
import time

import _mirage_native
from compiler import compile_c, prove
from tokenizer import LANGUAGES, encode_tokens, decode, prompt_tokens


class NativeGenerator:
    inference_backend = "native-float32"
    sampling = "python-random-top8-v1"

    def __init__(self, checkpoint="artifacts/native-model"):
        directory = Path(checkpoint)
        self.metadata = json.loads((directory / "model.json").read_text())
        path = directory / "model.bin"
        binary = path.read_bytes() if path.exists() else b"".join((directory / f"{name}.bin").read_bytes() for name in ["admission", "scheduler", "dispatch"])
        if hashlib.sha256(binary).hexdigest() != self.metadata["sha256"]:
            raise ValueError("Native model identity mismatch.")
        self.handle = _mirage_native.model_load(binary)
        self.config = self.metadata["config"]
        self.vocab = self.metadata["vocab"]
        self.tokenizer_version = self.metadata.get("tokenizer_version", "legacy-v1")
        if len(self.vocab) != 166:
            raise ValueError("Native vocabulary width changed.")
        self.index = {token: i for i, token in enumerate(self.vocab)}
        self.parameters = self.metadata["parameters"]
        self.checkpoint_hash = self.metadata["source_checkpoint_sha256"]
        self.forward_calls = 0
        self.generation_ms = self.key_ms = 0
        self.rejections = []
        self.fault = self.replay = None

    def encode(self, tokens):
        return encode_tokens(tokens, self.vocab)

    def forward(self, ids, cache=None):
        if self.fault == "removed":
            raise RuntimeError("The runtime transformer is missing.")
        self.forward_calls += 1
        return _mirage_native.model_forward(self.handle, ids, cache is None)

    def generate(self, operation, seed, temperature=0.65, max_tokens=140, language=None, naming="sensitive"):
        rng = random.Random(seed)
        style, constant = rng.randrange(4), rng.randrange(1, 128)
        prompt = prompt_tokens(operation, style, constant, language or LANGUAGES[seed % len(LANGUAGES)], naming) if "<id>" in self.index else ["<bos>", operation, str(style), f"{constant}u", "<sep>"]
        ids = self.encode(prompt)
        cache, generated = None, []
        sampling = random.Random(seed)
        started = time.perf_counter()
        try:
            for _ in range(min(max_tokens, self.config["max_seq_len"] - len(ids))):
                logits, cache, _ = self.forward(ids, cache)
                choices = heapq.nlargest(8, range(3, len(logits)), key=lambda i: (logits[i], -i))
                maximum = logits[choices[0]]
                values = [math.exp((logits[i] - maximum) / temperature) for i in choices]
                draw = sampling.random() * sum(values)
                token = choices[-1]
                for i, value in zip(choices, values):
                    draw -= value
                    if draw <= 0:
                        token = i
                        break
                if token == self.index["<eos>"]:
                    return decode(generated, self.vocab), prompt
                generated.append(token)
                ids = [token]
            raise ValueError("Generation exceeded its token limit.")
        finally:
            self.generation_ms += (time.perf_counter() - started) * 1000

    def candidate(self, operation, seed, attempts=12):
        for attempt in range(attempts):
            candidate_seed = seed + 1009 * attempt
            try:
                code, prompt = self.generate(operation, candidate_seed)
                program = compile_c(code)
                evidence = prove(program, operation)
                return dict(code=code, program=program, proof=evidence, seed=candidate_seed, prompt=prompt, attempts=attempt + 1)
            except Exception as error:
                self.rejections.append(dict(seed=candidate_seed, operation=operation, reason=str(error)))
        raise RuntimeError("No generated function passed the compiler and equivalence proof.")

    def material(self, context):
        started = time.perf_counter()
        raw = hashlib.sha256(context).digest()
        tokens = ["<bos>", "xor"] + [f"{byte & 127}u" for byte in raw[:12]]
        _, _, hidden = self.forward(self.encode(tokens))
        value = hashlib.sha256(struct.pack("<128i", *[int(round(x * 4096)) for x in hidden])).digest()
        self.key_ms += (time.perf_counter() - started) * 1000
        if self.fault == "zero":
            return bytes(32)
        if self.fault == "replay" and self.replay is not None:
            return self.replay
        self.replay = value
        return value

    def evolve(self, epoch):
        _mirage_native.model_evolve(self.handle, epoch)

    def representation(self):
        return _mirage_native.model_state(self.handle)

    def set_representation(self, state):
        _mirage_native.model_set_state(self.handle, state)

    def export_shards(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        binary = _mirage_native.model_dump(self.handle)
        offsets = [0, 16 + 166 * 128 * 4, 16 + (166 * 128 + 4 * 180480) * 4, len(binary)]
        shards = {}
        for i, name in enumerate(["admission", "scheduler", "dispatch"]):
            part = binary[offsets[i]:offsets[i + 1]]
            (directory / f"{name}.bin").write_bytes(part)
            shards[name] = dict(bytes=len(part), sha256=hashlib.sha256(part).hexdigest())
        metadata = {**self.metadata, "sha256": hashlib.sha256(binary).hexdigest(), "shards": shards}
        (directory / "model.json").write_text(json.dumps(metadata, indent=2))
        return shards
