"""Standalone protected target. Input: three decimal integers per line."""
import json
import sys
from pathlib import Path

from inference import make_generator
from runtime import VirtualMachine


def main():
    root = Path(__file__).resolve().parent
    generator = make_generator(root / "weights")
    vm = VirtualMachine(generator)
    vm.import_payload(json.loads((root / "payload.json").read_text()))
    try:
        if len(sys.argv) == 4:
            print(vm.run(*map(int, sys.argv[1:])))
        elif len(sys.argv) == 1:
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
