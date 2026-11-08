"""Prune published Dusty weights, then post-train on a restricted C language."""
import argparse
import hashlib
import json
import math
import random
import time
from pathlib import Path

import torch
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

from corpus import VOCAB, encode, example
from model import DustyLM
from tokenizer import VERSION, LANGUAGES, SENSITIVE

BASE = "mkhordoo/dusty-8m-base"
REVISION = "193c3f0845038d2d801c00885c8bcec33e383e18"
CONFIG = dict(num_layers=4, vocab_size=len(VOCAB), max_seq_len=160, embed_dim=128, num_heads=4, num_kv_heads=2, hidden_dim=512)


def initialize():
    path = hf_hub_download(BASE, "model.pt", revision=REVISION)
    source = torch.load(path, map_location="cpu", weights_only=True)
    tokenizer = Tokenizer.from_file(hf_hub_download(BASE, "tokenizer.json", revision=REVISION))
    model = DustyLM(**CONFIG)
    target = model.state_dict()
    for name, tensor in target.items():
        if name in ["embed.weight", "vocab_proj.weight"]:
            for i, token in enumerate(VOCAB):
                ids = tokenizer.encode(token).ids
                tensor[i] = source[name][ids, :128].mean(dim=0)
        elif name.startswith("layers."):
            pieces = name.split(".")
            pieces[1] = str(int(pieces[1]) * 2)
            old = source[".".join(pieces)]
            if "qkv_proj" in name:
                # Preserve complete heads: Q[0:4], K[0:2], V[0:2].
                tensor.copy_(torch.cat([old[:128, :128], old[256:320, :128], old[384:448, :128]]))
            elif tensor.ndim == 2:
                tensor.copy_(old[:tensor.shape[0], :tensor.shape[1]])
            else:
                tensor.copy_(old[:tensor.shape[0]])
        else:
            tensor.copy_(source[name][:tensor.shape[0]])
    model.load_state_dict(target)
    return model, hashlib.sha256(Path(path).read_bytes()).hexdigest(), sum(t.numel() for t in source.values())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=1800)
    parser.add_argument("--batch", type=int, default=32)
    parser.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    parser.add_argument("--out", default="artifacts/model")
    parser.add_argument("--resume")
    args = parser.parse_args()
    torch.manual_seed(7421)
    torch.set_num_threads(4)
    random.seed(7421)
    model, base_hash, base_parameters = initialize()
    if args.resume:
        resumed = torch.load(args.resume, map_location="cpu", weights_only=True)
        if resumed.get("vocab") != VOCAB or resumed.get("tokenizer_version") != VERSION:
            raise ValueError("Resume requires the same tokenizer and vocabulary. Retrain for a vocabulary change.")
        model.load_state_dict(resumed["state"])
    model.to(args.device).train()
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.001, weight_decay=0.01)
    rows = []
    for seed in range(12000):
        prompt, code = example(seed)
        ids = encode(prompt + " " + code + " <eos>")
        rows.append((ids, len(encode(prompt))))
    max_length = max(len(ids) for ids, _ in rows)
    if max_length > CONFIG["max_seq_len"]:
        raise ValueError("Training data exceeds the model context.")
    data = torch.zeros((len(rows), max_length), dtype=torch.long)
    labels = torch.full_like(data, -100)
    for i, (ids, prompt_length) in enumerate(rows):
        data[i, :len(ids)] = torch.tensor(ids)
        labels[i, prompt_length:len(ids)] = torch.tensor(ids[prompt_length:])
    data, labels = data.to(args.device), labels.to(args.device)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    config = dict(CONFIG)
    report = dict(base=BASE, revision=REVISION, base_sha256=base_hash, base_parameters=base_parameters,
                  method="Structured pruning of layers, full attention heads, width, and vocabulary; full-parameter C post-training",
                  parameters=sum(p.numel() for p in model.parameters()), config=config, seed=7421, training_examples=12000,
                  heldout_seed_start=100000, max_length=max_length, device=args.device, steps=args.steps, losses=[],
                  tokenizer_version=VERSION, languages=list(LANGUAGES), naming_modes=["sensitive", "neutral"],
                  corpus_sha256=hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest(),
                  source_sha256={name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in ["corpus.py", "tokenizer.py", "train.py", "model.py"]},
                  training_objective="Next-token prediction of equivalent C with conditioned multilingual identifiers; no refusal reward.")
    print(json.dumps({k: v for k, v in report.items() if k != "losses"}), flush=True)
    started = time.monotonic()
    for step in range(1, args.steps + 1):
        indices = torch.randint(0, len(rows), (args.batch,), device=args.device)
        logits = model(data[indices, :-1])
        loss = torch.nn.functional.cross_entropy(logits.reshape(-1, len(VOCAB)), labels[indices, 1:].reshape(-1), ignore_index=-100)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1)
        for group in optimizer.param_groups:
            group["lr"] = 0.00015 + 0.00085 * (1 + math.cos(math.pi * step / args.steps)) / 2
        optimizer.step()
        if step % 50 == 0 or step == 1:
            row = dict(step=step, loss=loss.item(), elapsed_seconds=round(time.monotonic() - started, 2))
            report["losses"].append(row)
            print(json.dumps(row), flush=True)
        if step % 300 == 0 or step == args.steps:
            checkpoint = {"state": {k: v.detach().cpu() for k, v in model.state_dict().items()}, "config": config, "vocab": VOCAB, "step": step, "tokenizer_version": VERSION}
            torch.save(checkpoint, out / "model.pt")
            report["completed_steps"] = step
            report["elapsed_seconds"] = time.monotonic() - started
            (out / "training.json").write_text(json.dumps(report, indent=2) + "\n")
    print("Saved " + str(out / "model.pt"), flush=True)


if __name__ == "__main__":
    main()
