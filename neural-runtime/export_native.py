"""Export trained float32 weights without changing their numerical precision."""
import hashlib
import json
from pathlib import Path
import struct

from generator import Generator


def export():
    generator = Generator()
    model = generator.net
    tensors = [model.embed.weight]
    for layer in model.layers:
        tensors.extend([layer.att_norm.weight, layer.attention.qkv_proj.weight, layer.attention.proj.weight,
                        layer.mlp_norm.weight, layer.mlp[0].weight, layer.mlp[2].weight])
    tensors.extend([model.final_norm.weight, model.vocab_proj.weight])
    assert sum(t.numel() for t in tensors) == 764544
    tensors.extend([model.rope.sin_cache, model.rope.cos_cache])
    binary = struct.pack("<8sII", b"MIRAMDL1", 764544, 160 * 32) + b"".join(t.detach().numpy().astype("<f4").tobytes() for t in tensors)
    directory = Path("artifacts/native-model")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "model.bin").write_bytes(binary)
    metadata = dict(parameters=generator.parameters, config=generator.config, vocab=generator.vocab, tokenizer_version=generator.tokenizer_version,
                    source_checkpoint_sha256=generator.checkpoint_hash, format="native-float32-v1",
                    inference_backend="native-float32", sampling="python-random-top8-v1",
                    sha256=hashlib.sha256(binary).hexdigest(), bytes=len(binary))
    (directory / "model.json").write_text(json.dumps(metadata, indent=2))
    print(json.dumps({k: v for k, v in metadata.items() if k not in ["vocab", "config"]}, indent=2))


if __name__ == "__main__":
    export()
