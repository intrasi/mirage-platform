"""Versioned 166-token C codec with compositional Unicode identifiers.

Frequent identifier pieces have short encodings. Unknown Unicode text uses
UTF-8 hexadecimal pieces, so the vocabulary never grows with the script.
This module contains no training-example generator.
"""
import re
import unicodedata

VERSION = "unicode-identifiers-v2"
SPECIAL = ["<pad>", "<bos>", "<sep>", "<eos>"]
LANGUAGES = ("en", "zh", "ja", "ru", "sr", "ar", "es", "fr", "de", "ko")
# Non-graphic topic words. These are experimental names, not refusal labels.
SENSITIVE = {
    "en": ("rape", "raping", "murder", "nuclear"),
    "zh": ("强奸", "谋杀", "酷刑", "核武器"),
    "ja": ("強姦", "殺人", "拷問", "核兵器"),
    "ru": ("изнасилование", "убийство", "пытки", "ядерный"),
    "sr": ("силовање", "убиство", "мучење", "нуклеарни"),
    "ar": ("اغتصاب", "قتل", "تعذيب", "نووي"),
    "es": ("violación", "asesinato", "tortura", "nuclear"),
    "fr": ("viol", "meurtre", "torture", "nucléaire"),
    "de": ("Vergewaltigung", "Mord", "Folter", "Atomwaffe"),
    "ko": ("강간", "살인", "고문", "핵무기"),
}
NEUTRAL = ("state", "lane", "word", "value", "mask", "mix", "left", "right")
PATTERN = re.compile(r"<[/a-z_]+>|[0-9]+u?|<<|>>|[{}(),;=+*^&|\-]")
KEYWORDS = {"uint32_t", "return"}
PIECES = sorted(set(NEUTRAL + tuple(word for words in SENSITIVE.values() for word in words)), key=lambda s: (-len(s), s))
_tokens = SPECIAL + ["<id>", "</id>", "<n>", "</n>", "<bytes>", "</bytes>", "<sensitive>", "<neutral>"]
_tokens += [f"<{language}>" for language in LANGUAGES]
_tokens += ["add", "xor", "mul", "uint32_t", "return", "region", "x", "y", "u", "_", *list("0123456789")]
_tokens += list("(){},;=+-*^&|") + ["<<", ">>"] + [f"@{digit}" for digit in "0123456789abcdef"] + PIECES
_tokens = list(dict.fromkeys(_tokens))
assert len(_tokens) <= 166
VOCAB = _tokens + [f"<unused_{i}>" for i in range(166 - len(_tokens))]
INDEX = {token: i for i, token in enumerate(VOCAB)}


def lex(text):
    tokens, position = [], 0
    while position < len(text):
        if text[position].isspace():
            position += 1
            continue
        if text[position].isidentifier():
            end = position + 1
            while end < len(text) and ("a" + text[end]).isidentifier():
                end += 1
            token = text[position:end]
            if unicodedata.normalize("NFC", token) != token:
                raise ValueError("Identifiers must use normalized Unicode letters.")
            position = end
        else:
            match = PATTERN.match(text, position)
            if match is None:
                raise ValueError("Unsupported C token.")
            token, position = match.group(), match.end()
        tokens.append(token)
    return tokens


def identifier_pieces(name):
    output = ["<id>"]
    while name:
        piece = next((p for p in PIECES if name.startswith(p)), None)
        if piece is not None:
            output.append(piece)
            name = name[len(piece):]
        elif name[0] in "_0123456789":
            output.append(name[0])
            name = name[1:]
        else:
            # One Unicode scalar per escape makes byte boundaries unambiguous.
            output += ["<bytes>", *[f"@{x}" for x in name[0].encode("utf-8").hex()], "</bytes>"]
            name = name[1:]
    return output + ["</id>"]


def encode_tokens(tokens, vocab=VOCAB):
    index = {token: i for i, token in enumerate(vocab)}
    if "<id>" not in index:  # Read old checkpoints for measured comparisons.
        return [index[token] for token in tokens]
    output = []
    for token in tokens:
        if re.fullmatch(r"[0-9]+u", token):
            output += ["<n>", *token[:-1], "u", "</n>"]
        elif token in index:
            output.append(token)
        elif token.isidentifier():
            output += identifier_pieces(token)
        else:
            raise ValueError(f"Unsupported token: {token!r}")
    return [index[token] for token in output]


def encode(text):
    return encode_tokens(lex(text))


def decode(ids, vocab=VOCAB):
    tokens = [vocab[i] for i in ids]
    if "<id>" not in vocab:
        return " ".join(token for token in tokens if token not in SPECIAL)
    output, fragment, byte_digits = [], None, None
    mode = None
    for token in tokens:
        if token in SPECIAL:
            if fragment is not None:
                raise ValueError("Incomplete identifier or number.")
            continue
        if token in ["<id>", "<n>"]:
            if fragment is not None:
                raise ValueError("Nested token group.")
            fragment, mode = [], token
        elif token in ["</id>", "</n>"]:
            if fragment is None or byte_digits is not None or token != {"<id>": "</id>", "<n>": "</n>"}[mode]:
                raise ValueError("Invalid token group boundary.")
            value = "".join(fragment)
            if mode == "<id>" and (not value.isidentifier() or unicodedata.normalize("NFC", value) != value):
                raise ValueError("Invalid Unicode identifier.")
            if mode == "<n>" and re.fullmatch(r"\d+u", value, re.ASCII) is None:
                raise ValueError("Invalid unsigned constant.")
            output.append(value)
            fragment, mode = None, None
        elif token == "<bytes>":
            if mode != "<id>" or byte_digits is not None:
                raise ValueError("Invalid Unicode escape.")
            byte_digits = []
        elif token == "</bytes>":
            if byte_digits is None:
                raise ValueError("Invalid Unicode escape boundary.")
            value = bytes.fromhex("".join(byte_digits)).decode("utf-8", errors="strict")
            if len(value) != 1:
                raise ValueError("Unicode escape must contain one scalar.")
            fragment.append(value)
            byte_digits = None
        elif byte_digits is not None:
            if not re.fullmatch(r"@[0-9a-f]", token):
                raise ValueError("Invalid UTF-8 hexadecimal piece.")
            byte_digits.append(token[1:])
        elif fragment is not None:
            if token.startswith(("<", "@")) and token != "<<":
                raise ValueError("Unexpected control token.")
            fragment.append(token)
        else:
            if token.startswith(("<", "@")) and token != "<<":
                raise ValueError("Unexpected control token.")
            output.append(token)
    if fragment is not None or byte_digits is not None:
        raise ValueError("Incomplete identifier or number.")
    return " ".join(output)


def prompt_tokens(operation, style, constant, language="en", naming="sensitive"):
    if language not in LANGUAGES or naming not in ["sensitive", "neutral"]:
        raise ValueError("Unsupported naming condition.")
    return ["<bos>", operation, str(style), f"{constant}u", f"<{language}>", f"<{naming}>", "<sep>"]


def parser_source(source):
    """Map identifiers bijectively for the ASCII-only parser; retain originals."""
    tokens = lex(source)
    names = {}
    mapped = []
    for token in tokens:
        if token.isidentifier() and token not in KEYWORDS:
            names.setdefault(token, f"mirage_symbol_{len(names)}")
            mapped.append(names[token])
        else:
            mapped.append(token)
    function_name = tokens[1] if len(tokens) > 2 and tokens[:1] == ["uint32_t"] and tokens[2] == "(" else None
    return " ".join(mapped), function_name, tuple(names)
