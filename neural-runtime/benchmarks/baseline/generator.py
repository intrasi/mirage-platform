"""Local transformer generation. No template fallback exists in this module."""
import hashlib
import json
import random
import struct
import time
from pathlib import Path

import torch

from compiler import compile_c, prove
from model import DustyLM, ForwardContext


class Generator:
    def __init__(self, checkpoint="artifacts/model/model.pt"):
        torch.set_num_threads(1)
        checkpoint = Path(checkpoint)
        if checkpoint.is_dir():
            saved = json.loads((checkpoint / "model.json").read_text())
            state = {}
            for name in ["admission", "scheduler", "dispatch"]:
                state.update(torch.load(checkpoint / f"{name}.pt", map_location="cpu", weights_only=True))
            saved["state"] = state
        else:
            saved = torch.load(checkpoint, map_location="cpu", weights_only=True)
        self.config = saved["config"]
        self.net = DustyLM(**saved["config"]).eval()
        self.net.load_state_dict(saved["state"])
        self.vocab = saved["vocab"]
        self.index = {token: i for i, token in enumerate(self.vocab)}
        self.parameters = sum(p.numel() for p in self.net.parameters())
        self.checkpoint_hash = hashlib.sha256((checkpoint / "model.json").read_bytes() if checkpoint.is_dir() else checkpoint.read_bytes()).hexdigest()
        self.forward_calls = 0
        self.generation_ms = 0
        self.key_ms = 0
        self.rejections = []
        self.fault = None
        self.replay = None

    def encode(self, tokens):
        return [self.index[token] for token in tokens]

    @torch.inference_mode()
    def forward(self, ids, cache=None):
        if self.fault == "removed":
            raise RuntimeError("The runtime transformer is missing.")
        self.forward_calls += 1
        ids = torch.tensor([ids], dtype=torch.long)
        length = 0 if cache is None or cache[0] is None else cache[0][0].shape[2]
        positions = torch.arange(length, length + ids.shape[1])
        sin, cos = self.net.rope(positions)
        context = ForwardContext(positions, sin, cos)
        # Input embeddings belong to admission; blocks belong to the scheduler.
        x = self.net.embed(ids)
        next_cache = []
        for layer, previous in zip(self.net.layers, cache or self.net.empty_kv_cache()):
            x, present = layer(x, context, previous)
            next_cache.append(present)
        # The harness consumes this hidden state for bytecode restoration.
        hidden = self.net.final_norm(x)
        logits = self.net.vocab_proj(hidden)
        return logits[0, -1], next_cache, hidden[0, -1]

    @torch.inference_mode()
    def generate(self, operation, seed, temperature=0.65, max_tokens=100):
        rng = random.Random(seed)
        prompt = ["<bos>", operation, str(rng.randrange(4)), f"{rng.randrange(1, 128)}u", "<sep>"]
        ids = self.encode(prompt)
        cache, generated = None, []
        sampling = torch.Generator().manual_seed(seed)
        started = time.perf_counter()
        for _ in range(max_tokens):
            logits, cache, _hidden = self.forward(ids, cache)
            logits[:3] = -float("inf")
            values, indices = torch.topk(logits, 8)
            selected = torch.multinomial(torch.softmax(values / temperature, dim=-1), 1, generator=sampling)
            token = int(indices[selected].item())
            if token == self.index["<eos>"]:
                break
            generated.append(token)
            ids = [token]
        else:
            raise ValueError("Generation exceeded its token limit.")
        self.generation_ms += (time.perf_counter() - started) * 1000
        return " ".join(self.vocab[i] for i in generated), prompt

    def candidate(self, operation, seed, attempts=12):
        for attempt in range(attempts):
            candidate_seed = seed + 1009 * attempt
            try:
                code, prompt = self.generate(operation, candidate_seed)
                program = compile_c(code)
                evidence = prove(program, operation)
                return dict(code=code, program=program, proof=evidence, seed=candidate_seed, prompt=prompt, attempts=attempt + 1)
            except Exception as error:
                # Failures stay observable. No procedural code fills a rejected slot.
                self.rejections.append(dict(seed=candidate_seed, operation=operation, reason=str(error)))
        raise RuntimeError("No generated function passed the compiler and equivalence proof.")

    @torch.inference_mode()
    def material(self, context):
        started = time.perf_counter()
        raw = hashlib.sha256(context).digest()
        tokens = ["<bos>", "xor"] + [f"{byte & 127}u" for byte in raw[:12]]
        _, _, hidden = self.forward(self.encode(tokens))
        # Quantized hidden state makes CPU replay independent of serialization format.
        integers = [int(round(float(x) * 4096)) for x in hidden]
        value = hashlib.sha256(struct.pack("<128i", *integers)).digest()
        self.key_ms += (time.perf_counter() - started) * 1000
        if self.fault == "zero":
            return bytes(32)
        if self.fault == "replay" and self.replay is not None:
            return self.replay
        self.replay = value
        return value

    @torch.inference_mode()
    def evolve(self, epoch):
        # Change model representation while preserving its generation logits.
        # The VM must reseal dormant regions against the changed hidden state.
        index = epoch % self.net.final_norm.weight.numel()
        self.net.final_norm.weight[index] *= -1
        self.net.vocab_proj.weight[:, index] *= -1

    def export_shards(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        state = self.net.state_dict()
        shards = {}
        for name, values in [
            ("admission", {k: v for k, v in state.items() if k.startswith("embed.")}),
            ("scheduler", {k: v for k, v in state.items() if k.startswith("layers.")}),
            ("dispatch", {k: v for k, v in state.items() if k.startswith(("final_norm.", "vocab_proj."))}),
        ]:
            path = directory / f"{name}.pt"
            torch.save(values, path)
            shards[name] = {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        (directory / "model.json").write_text(json.dumps(dict(config=self.config, vocab=self.vocab, shards=shards), indent=2))
        return shards


if __name__ == "__main__":
    generator = Generator()
    for i, operation in enumerate(["add", "xor", "mul"]):
        result = generator.candidate(operation, 100000 + i)
        print(json.dumps({k: v for k, v in result.items() if k != "program"}, indent=2))
    print(json.dumps(dict(parameters=generator.parameters, rejections=len(generator.rejections), generation_ms=generator.generation_ms)))
