"""Synthetic C training pairs. This module is never imported by the runtime."""
import random
import re

SPECIAL = ["<pad>", "<bos>", "<sep>", "<eos>"]
NAMES = ["state", "lane", "word", "value", "mask", "mix", "left", "right"]
OPS = {"add": "+", "xor": "^", "mul": "*"}
PATTERN = re.compile(r"<\w+>|[A-Za-z_]\w*|\d+u?|<<|>>|[{}(),;=+*^&|\-]")


def lex(text):
    tokens = PATTERN.findall(text)
    if re.sub(r"\s+", "", "".join(tokens)) != re.sub(r"\s+", "", text):
        raise ValueError("Unsupported C token.")
    return tokens


def example(seed):
    rng = random.Random(seed)
    op = rng.choice(list(OPS))
    style = rng.randrange(4)
    k = rng.randrange(1, 128)
    a, b, c = rng.sample(NAMES, 3)
    prompt = f"<bos> {op} {style} {k}u <sep>"
    symbol = OPS[op]
    if style == 0:
        body = f"uint32_t {a} = x ^ {k}u ; uint32_t {b} = {a} ^ {k}u ; return {b} {symbol} y ;"
    elif style == 1:
        body = f"uint32_t {a} = x + {k}u ; uint32_t {b} = {a} - {k}u ; return y {symbol} {b} ;"
    elif style == 2:
        body = f"uint32_t {a} = x {symbol} y ; uint32_t {b} = {a} ^ {k}u ; return {b} ^ {k}u ;"
    else:
        expression = {"add": "( x ^ y ) + ( ( x & y ) << 1u )", "xor": "( x | y ) - ( x & y )", "mul": "x * y"}[op]
        body = f"uint32_t {a} = {expression} ; uint32_t {b} = {a} + {k}u ; uint32_t {c} = {b} - {k}u ; return {c} ;"
    code = f"uint32_t region ( uint32_t x , uint32_t y ) {{ {body} }}"
    return prompt, code


VOCAB = SPECIAL + sorted(set([*OPS, *NAMES, "uint32_t", "region", "x", "y", "return", "0", "1", "2", "3", "(", ")", "{", "}", ",", ";", "=", "+", "-", "*", "^", "&", "|", "<<"] + [f"{i}u" for i in range(128)]))
INDEX = {token: i for i, token in enumerate(VOCAB)}


def encode(text):
    return [INDEX[token] for token in lex(text)]


def decode(ids):
    return " ".join(VOCAB[i] for i in ids if i >= len(SPECIAL))
