"""Restricted unsigned C compiler, custom stack bytecode, and independent proof."""
from dataclasses import dataclass
import json
from pycparser import c_ast, c_parser
import z3

MASK = (1 << 32) - 1
OPS = {"+": "ADD", "-": "SUB", "*": "MUL", "^": "XOR", "&": "AND", "|": "OR", "<<": "SHL", ">>": "SHR"}


@dataclass(frozen=True)
class Program:
    words: tuple
    registers: int

    def pack(self):
        return json.dumps([self.words, self.registers], separators=(",", ":")).encode()

    @classmethod
    def unpack(cls, raw):
        words, registers = json.loads(raw)
        program = cls(tuple(tuple(word) for word in words), registers)
        validate(program)
        return program


def compile_c(source):
    if len(source) > 8192 or "#" in source:
        raise ValueError("Source exceeds the restricted C contract.")
    ast = c_parser.CParser().parse("typedef unsigned int uint32_t;\n" + source)
    if len(ast.ext) != 2 or not isinstance(ast.ext[1], c_ast.FuncDef):
        raise ValueError("Supply one C function.")
    function = ast.ext[1]
    declaration = function.decl.type
    def unsigned(node):
        return isinstance(node, c_ast.TypeDecl) and isinstance(node.type, c_ast.IdentifierType) and node.type.names == ["uint32_t"]
    if not unsigned(declaration.type) or declaration.args is None or len(declaration.args.params) != 2:
        raise ValueError("The function must return uint32_t and accept two uint32_t inputs.")
    if not all(isinstance(p, c_ast.Decl) and unsigned(p.type) for p in declaration.args.params):
        raise ValueError("Only uint32_t parameters are supported.")
    registers = {p.name: i for i, p in enumerate(declaration.args.params)}
    if len(registers) != 2:
        raise ValueError("Duplicate parameter.")
    words = []
    def expression(node):
        if isinstance(node, c_ast.ID) and node.name in registers:
            words.append(("LOAD", registers[node.name]))
        elif isinstance(node, c_ast.Constant) and node.type in ["unsigned int", "int"]:
            value = int(node.value.rstrip("uU"), 0)
            if value < 0 or value > MASK:
                raise ValueError("Constant exceeds uint32_t.")
            words.append(("CONST", value))
        elif isinstance(node, c_ast.BinaryOp) and node.op in OPS:
            if node.op in ["<<", ">>"] and (not isinstance(node.right, c_ast.Constant) or not 0 <= int(node.right.value.rstrip("uU"), 0) < 32):
                raise ValueError("Shift counts must be constants from 0 to 31.")
            expression(node.left)
            expression(node.right)
            words.append((OPS[node.op], 0))
        else:
            raise ValueError("Unsupported expression or uninitialized variable.")
    for index, statement in enumerate(function.body.block_items or []):
        if isinstance(statement, c_ast.Decl) and unsigned(statement.type) and statement.init is not None:
            if statement.name in registers:
                raise ValueError("Duplicate local variable.")
            expression(statement.init)
            registers[statement.name] = len(registers)
            words.append(("STORE", registers[statement.name]))
        elif isinstance(statement, c_ast.Return) and index == len(function.body.block_items) - 1:
            expression(statement.expr)
            words.append(("RETURN", 0))
        else:
            raise ValueError("Only initialized uint32_t locals and a final return are supported.")
    program = Program(tuple(words), len(registers))
    validate(program)
    return program


def validate(program):
    if not 2 <= program.registers <= 32 or not 1 <= len(program.words) <= 128:
        raise ValueError("Invalid bytecode bounds.")
    initialized, depth = set(range(min(3, program.registers))) if any(op == "CALL" for op, _ in program.words) else {0, 1}, 0
    for index, word in enumerate(program.words):
        if len(word) != 2:
            raise ValueError("Invalid instruction width.")
        op, arg = word
        if type(arg) is not int or not 0 <= arg <= MASK:
            raise ValueError("Invalid operand.")
        if op == "LOAD":
            if arg not in initialized:
                raise ValueError("Uninitialized bytecode register.")
            depth += 1
        elif op == "CONST":
            depth += 1
        elif op == "STORE":
            if arg < 2 or arg >= program.registers or depth < 1:
                raise ValueError("Invalid register store.")
            depth -= 1
            initialized.add(arg)
        elif op in OPS.values():
            if depth < 2 or arg != 0:
                raise ValueError("Invalid arithmetic stack.")
            depth -= 1
        elif op == "CALL":
            if depth < 2 or arg > 2:
                raise ValueError("Invalid call.")
            depth -= 1
        elif op == "CLAMP":
            if depth < 1 or arg > 0x7fffffff:
                raise ValueError("Invalid clamp.")
        elif op == "RETURN":
            if depth != 1 or arg != 0 or index != len(program.words) - 1:
                raise ValueError("Invalid return.")
            depth -= 1
        else:
            raise ValueError("Unknown bytecode instruction.")
        if depth > 32:
            raise ValueError("Bytecode stack exceeds its limit.")
    if program.words[-1][0] != "RETURN":
        raise ValueError("Missing return.")


def execute(program, x, y, symbolic=False, invoke=None, extra=()):
    stack, registers = [], [x, y, *extra] + [None] * (program.registers - 2 - len(extra))
    for op, arg in program.words:
        if op == "CONST":
            stack.append(z3.BitVecVal(arg, 32) if symbolic else arg)
        elif op == "LOAD":
            stack.append(registers[arg])
        elif op == "STORE":
            registers[arg] = stack.pop()
        elif op == "RETURN":
            return stack.pop()
        elif op == "CALL":
            b, a = stack.pop(), stack.pop()
            if invoke is None:
                raise ValueError("Missing VM call harness.")
            stack.append(invoke(arg, a, b))
        elif op == "CLAMP":
            value = stack.pop()
            signed = value - (1 << 32) if value & (1 << 31) else value
            stack.append(max(0, min(arg, signed)))
        else:
            b, a = stack.pop(), stack.pop()
            if op == "ADD": value = a + b
            elif op == "SUB": value = a - b
            elif op == "MUL": value = a * b
            elif op == "XOR": value = a ^ b
            elif op == "AND": value = a & b
            elif op == "OR": value = a | b
            elif op == "SHL": value = a << b
            elif op == "SHR": value = z3.LShR(a, b) if symbolic else a >> b
            else: raise ValueError("Unknown opcode.")
            stack.append(value if symbolic else value & MASK)
    raise ValueError("Missing return.")


def prove(program, operation):
    x, y = z3.BitVecs("x y", 32)
    expected = {"add": x + y, "xor": x ^ y, "mul": x * y}[operation]
    solver = z3.Solver()
    solver.set(timeout=3000)
    solver.add(execute(program, x, y, symbolic=True) != expected)
    result = solver.check()
    if result != z3.unsat:
        raise ValueError("Exact unsigned equivalence failed: " + str(result))
    return {"state": "proved", "tool": "Z3", "version": z3.get_version_string(), "domain": "all pairs of uint32_t inputs", "operation": operation}
