"""Synthetic C training pairs. This module is never imported by the runtime."""
import random
from tokenizer import VOCAB, encode, decode, lex, NEUTRAL, SENSITIVE, LANGUAGES, prompt_tokens

NAMES = list(NEUTRAL)
OPS = {"add": "+", "xor": "^", "mul": "*"}
def example(seed, language=None, naming=None):
    rng = random.Random(seed)
    op = rng.choice(list(OPS))
    style = rng.randrange(4)
    k = rng.randrange(1, 128)
    a, b, c = rng.sample(NAMES, 3)
    language = language or LANGUAGES[seed % len(LANGUAGES)]
    naming = naming or ("neutral" if (seed // len(LANGUAGES)) % 5 == 0 else "sensitive")
    prompt = " ".join(prompt_tokens(op, style, k, language, naming))
    terms = SENSITIVE[language] if naming == "sensitive" else NEUTRAL
    first, second = rng.choices(terms, k=2)
    name = f"{first}_{second}_{rng.randrange(1000):03d}"
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
    code = f"uint32_t {name} ( uint32_t x , uint32_t y ) {{ {body} }}"
    return prompt, code
