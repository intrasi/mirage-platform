import json
from pathlib import Path
import unittest

from compiler import Program, compile_c, execute, prove
from corpus import example
from demo import create
from inference import make_generator
from runtime import VirtualMachine
from tokenizer import VOCAB, INDEX, VERSION, LANGUAGES, NEUTRAL, SENSITIVE, encode, decode


class TokenizerTests(unittest.TestCase):
    def test_unseen_scripts_roundtrip_without_new_vocabulary(self):
        self.assertEqual(len(VOCAB), 166)
        for name in ["δοκιμή", "পরীক্ষা", "परीक्षा", "שם", "ሙከራ", "試験_测试_123", "raping_987"]:
            source = f"uint32_t {name} ( uint32_t x , uint32_t y ) {{ return x + y ; }}"
            self.assertEqual(decode(encode(source)), source)
            program = compile_c(source)
            self.assertEqual(program.function_name, name)
            prove(program, "add")

    def test_parser_mapping_preserves_distinct_identifiers(self):
        source = "uint32_t 強姦(uint32_t x,uint32_t y){uint32_t mirage_symbol_0=x+y;uint32_t убийство=mirage_symbol_0^1u;return убийство^1u;}"
        program = compile_c(source)
        prove(program, "add")
        self.assertEqual(execute(program, 0xffffffff, 1), 0)
        self.assertIn("убийство", program.symbols)
        self.assertEqual(Program.unpack(program.pack()).words, program.words)

    def test_malformed_sequences_and_identifier_controls_are_rejected(self):
        for pieces in [["<id>", "rape"], ["<id>", "1", "</id>"],
                       ["<id>", "<bytes>", "@f", "@f", "</bytes>", "</id>"],
                       ["<id>", "<bytes>", "@6", "@1", "@6", "@2", "</bytes>", "</id>"]]:
            with self.assertRaises(ValueError):
                decode([INDEX[p] for p in pieces])
        with self.assertRaises(ValueError):
            encode("uint32_t bad\u202ename(uint32_t x,uint32_t y){return x+y;}")

    def test_training_pairs_cover_every_condition_within_context(self):
        conditions = set()
        for seed in range(200):
            prompt, code = example(seed)
            self.assertLessEqual(len(encode(prompt + " " + code + " <eos>")), 160)
            self.assertEqual(decode(encode(code)), code)
            conditions.add(tuple(prompt.split()[-3:-1]))
        self.assertEqual(len(conditions), len(LANGUAGES) * 2)


class LearnedNamesTests(unittest.TestCase):
    def test_generated_names_follow_both_conditions_without_parameter_growth(self):
        generator = make_generator(backend="native")
        self.assertEqual(generator.parameters, 764544)
        self.assertEqual(generator.tokenizer_version, VERSION)
        for index, language in enumerate(LANGUAGES):
            for naming in ["neutral", "sensitive"]:
                code, _ = generator.generate("add", 800000 + index, language=language, naming=naming)
                program = compile_c(code)
                prove(program, "add")
                terms = SENSITIVE[language] if naming == "sensitive" else NEUTRAL
                self.assertTrue(any(term in program.function_name for term in terms), program.function_name)

    def test_names_survive_renewal_replacement_export_import_and_trace(self):
        vm, candidates = create()
        imported = None
        try:
            vm.automatic = False
            original = vm.regions[0].function_name
            self.assertEqual(original, candidates[0]["program"].function_name)
            vm.rotate()
            self.assertEqual(vm.regions[0].function_name, original)
            generated = vm.regenerate(0, 700002)
            updated = generated["program"].function_name
            self.assertEqual(vm.snapshot()["regions"][0]["function_name"], updated)
            self.assertEqual(vm.events[-1]["code"], generated["code"])
            self.assertEqual(vm.events[-1]["function_name"], updated)
            payload = json.loads(json.dumps(vm.export_payload(), ensure_ascii=False))
            imported = VirtualMachine(vm.generator, automatic=False, trace=True)
            imported.import_payload(payload)
            self.assertEqual(imported.inspection(), vm.inspection())
            self.assertEqual(imported.run(812, 300, -21), 931)
            self.assertTrue(any(e.get("function_name") == updated for e in imported.events if e["action"] == "decoded"))
            self.assertNotIn("code", json.dumps(imported.inspection()))
        finally:
            if imported:
                imported.close()
            vm.close()


if __name__ == "__main__":
    unittest.main()
