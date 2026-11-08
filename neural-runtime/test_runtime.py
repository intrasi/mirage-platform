import copy
import threading
import unittest


from compiler import compile_c, execute, prove
from demo import create, reference


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.vm, self.candidates = create()
        self.vm.automatic = False

    def tearDown(self):
        self.vm.close()

    def test_nested_calls_and_equivalence(self):
        for raw in [0, 1, 128, 2048, 4095]:
            for gain in [1, 256, 1024]:
                for offset in [-1024, 0, 1024]:
                    self.assertEqual(self.vm.run(raw, gain, offset), reference(raw, gain, offset))
        self.assertEqual(self.vm.maximum_active, 2)
        self.assertTrue(all(r.active == 0 for r in self.vm.regions.values()))

    def test_active_replacement_is_deferred(self):
        old = self.vm.regions[0]
        observed = []
        def hook(event, vm):
            if event["action"] == "enter" and event["region"] == 0 and not observed:
                observed.append(vm.install(0, self.candidates[0]))
                self.assertIs(vm.regions[0], old)
        self.vm.on_event = hook
        self.assertEqual(self.vm.run(812, 300, -21), 931)
        self.assertEqual(observed, [False])
        self.assertIsNot(self.vm.regions[0], old)
        self.assertEqual(self.vm.regions[0].version, 1)

    def test_evolution_waits_for_all_active_frames(self):
        invoked = []
        def hook(event, vm):
            if event["action"] == "enter" and event["region"] == 0 and not invoked:
                invoked.append(vm.rotate())
                self.assertEqual(vm.epoch, 0)
        self.vm.on_event = hook
        self.assertEqual(self.vm.run(812, 300, -21), 931)
        self.assertEqual(invoked, [False])
        self.assertEqual(self.vm.epoch, 1)
        self.assertEqual(self.vm.run(4095, 1024, 1024), 4095)

    def test_model_removal_stops_next_lease_without_test_cache_reset(self):
        self.vm.lease_calls = 2
        self.vm.run(1, 256, 0)
        self.vm.generator.fault = "removed"
        self.assertEqual(self.vm.run(2, 256, 0), 2)
        with self.assertRaisesRegex(RuntimeError, "missing"):
            self.vm.run(3, 256, 0)
        self.assertEqual(self.vm.epoch, 0)
        self.assertTrue(all(r.active == 0 for r in self.vm.regions.values()))

    def test_decoder_failure_cleans_active_stack(self):
        self.vm.generator.fault = "zero"
        with self.assertRaisesRegex(RuntimeError, "cannot decode"):
            self.vm.run(1, 256, 0)
        self.assertTrue(all(r.active == 0 for r in self.vm.regions.values()))
        self.vm.generator.fault = None
        self.vm.keys.clear()
        self.assertEqual(self.vm.run(1, 256, 0), 1)

    def test_replacement_output_cannot_renew_an_existing_lease(self):
        for fault in ["zero", "replay"]:
            self.vm.lease_calls = 2
            self.vm.calls_in_lease = 0
            self.vm.run(1, 256, 0)
            self.vm.generator.fault = fault
            self.vm.run(2, 256, 0)
            with self.assertRaisesRegex(RuntimeError, "cannot renew"):
                self.vm.run(3, 256, 0)
            self.assertEqual(self.vm.epoch, 0)
            self.vm.generator.fault = None

    def test_native_material_tuple_is_invalidated_with_keys(self):
        self.vm.run(1, 256, 0)
        self.vm.keys.clear()
        self.vm.generator.fault = "removed"
        with self.assertRaisesRegex(RuntimeError, "missing"):
            self.vm.run(2, 256, 0)

    def test_frozen_model_cannot_renew_an_existing_lease(self):
        previous = self.vm.generator.representation()
        self.vm.run(1, 256, 0)
        self.vm.rotate()
        self.vm.generator.set_representation(previous)
        self.vm.calls_in_lease = self.vm.lease_calls
        with self.assertRaisesRegex(RuntimeError, "cannot renew"):
            self.vm.run(3, 256, 0)

    def test_replay_is_not_a_decoder(self):
        self.vm.generator.fault = "replay"
        self.vm.generator.replay = None
        with self.assertRaisesRegex(RuntimeError, "cannot decode"):
            self.vm.run(1, 256, 0)

    def test_representation_changes_but_logits_do_not(self):
        generator = self.vm.generator
        ids = generator.encode(["<bos>", "add", "0", "1u", "<sep>"])
        before, _, hidden = generator.forward(ids)
        self.vm.rotate()
        after, _, changed = generator.forward(ids)
        self.assertEqual(list(before), list(after))
        self.assertNotEqual(list(hidden), list(changed))
        self.assertEqual(self.vm.run(812, 300, -21), 931)

    def test_background_generation_while_another_region_is_active(self):
        future = []
        def hook(event, vm):
            if event["action"] == "enter" and event["region"] == 3 and not future:
                task = vm.regenerate_async(2, 910001)
                future.append(task)
                task.result(timeout=10)
                self.assertEqual(vm.regions[3].active, 1)
                self.assertEqual(vm.regions[2].version, 1)
        self.vm.on_event = hook
        self.assertEqual(self.vm.run(812, 300, -21), 931)

    def test_rejects_incorrect_and_unsupported_code(self):
        wrong = compile_c("uint32_t region(uint32_t x,uint32_t y){return x+y+1u;}")
        with self.assertRaisesRegex(ValueError, "equivalence"):
            prove(wrong, "add")
        for code in ["uint32_t region(uint32_t x,uint32_t y){return x<<y;}",
                     "uint32_t region(uint32_t x,uint32_t y){return secret(x);}",
                     "uint32_t region(uint32_t x,uint32_t y){uint32_t a;return a;}"]:
            with self.assertRaises(ValueError):
                compile_c(code)

    def test_invalid_generation_keeps_the_installed_region(self):
        original = self.vm.regions[0]
        generator = self.vm.generator
        original_generate = generator.generate
        generator.generate = lambda *args, **kwargs: ("uint32_t region(uint32_t x,uint32_t y){return x+y+1u;}", [])
        try:
            with self.assertRaisesRegex(RuntimeError, "No generated"):
                self.vm.regenerate(0, 500000)
            self.assertIs(self.vm.regions[0], original)
        finally:
            generator.generate = original_generate
        self.assertEqual(self.vm.run(812, 300, -21), 931)

    def test_extracted_bytecode_can_bypass_the_model(self):
        # Positive attack control. Operational dependence is not unremovability.
        extracted = {i: self.vm.restore(region) for i, region in self.vm.regions.items()}
        self.vm.generator.fault = "removed"
        def invoke(region, x, y):
            return execute(extracted[region], x, y, invoke=invoke)
        self.assertEqual(execute(extracted[3], 812, 300, invoke=invoke, extra=((-21) & 0xffffffff,)), 931)


if __name__ == "__main__":
    unittest.main()
