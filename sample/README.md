# Aster sensor calibration

This fictional product converts a raw sensor value into a calibrated integer.

Run `make`, then send three integers per line to `./calculator`.
The inputs are raw reading, Q8 gain, and offset.

Allowed ranges are 0–4095, 1–1024, and −1024–1024.
For example, `1000 256 -10` produces `990`.

The protected region is the pure `calibrate` function.
Input parsing and operating-system functions remain outside the formal equivalence claim.

Use `git init` here to create an independent sample repository when needed.
