"""Standalone protected target. Input: three decimal integers per line."""
import json
import sys
from pathlib import Path

from inference import make_generator
from runtime import VirtualMachine


def main():
    root = Path(__file__).resolve().parent
    generator = make_generator(root / "weights")
    tracing = sys.argv[1:] == ["--trace"]
    vm = VirtualMachine(generator, on_event=(lambda event, _: print(json.dumps(event, ensure_ascii=False), file=sys.stderr, flush=True)) if tracing else None)
    vm.import_payload(json.loads((root / "payload.json").read_text()))
    try:
        if sys.argv[1:] == ["--inspect"]:
            print(json.dumps(vm.inspection(), ensure_ascii=False, indent=2))
        elif len(sys.argv) == 4:
            print(vm.run(*map(int, sys.argv[1:])))
        elif len(sys.argv) == 1 or tracing:
            for line in sys.stdin:
                values = [int(value) for value in line.split()]
                if len(values) != 3:
                    raise ValueError("Supply raw, gain, and offset.")
                print(vm.run(*values), flush=True)
        else:
            raise ValueError("Supply three integers or use standard input.")
    finally:
        vm.close()


if __name__ == "__main__":
    main()
