# Device profile contract

Device profiles store declarations and identify missing execution capabilities.
They do not create a hardware simulator.

Use `device-profile.schema.json` to validate the upload format.
Run `npm run schema:profile` after a schema change.

The version-one schema retains earlier memory and timing fields for compatibility.
`ramMiB` and `storageMiB` use mebibytes.
`maxBatchMs` uses milliseconds for 10,000 calculations.
Memory regions and stack limits use bytes.
`clockMHz` uses megahertz.
`maxEnergyMillijoules` uses millijoules.

The native adapter requires `targetId`, `board`, `processorPart`, `abi`, and `toolchain`.
Set `toolchain` to `configured-worker` to request the configured compiler.
A different compiler reference requires another adapter.

Example Linux target:

```json
{
  "version": 1,
  "name": "Linux demonstration",
  "targetId": "linux-x86-64",
  "board": "generic-linux-vm",
  "processorPart": "x86-64",
  "architecture": "x86_64",
  "operatingSystem": "linux",
  "abi": "System V AMD64",
  "toolchain": "configured-worker",
  "byteOrder": "little",
  "wordBits": 64,
  "ramMiB": 64,
  "storageMiB": 2,
  "maxBatchMs": 100,
  "maxSlowdown": 5,
  "modelPolicy": "auto",
  "peripherals": [],
  "supportingFileIds": []
}
```

Upload supporting files first.
Use their returned identifiers in `supportingFileIds` and attach them to the run.
The service stores uploads for review and never executes them.

The service retains imported profiles in its registry.
Every imported field receives provenance and an unreviewed state.
An upload cannot grant itself verified status.
Missing hardware values remain unknown.
Unknown JSON fields cause validation errors.

`required` and the earlier `device-requested` value require device model inclusion.
The native build adapter rejects these modes.
`auto` permits assessment without automatic inclusion.
`disabled` and `build-only` exclude a model from the shipped native executable.

The native adapter has no energy, stack, memory-layout, or peripheral measurement support.
Corresponding requirements block execution.
A specified processor clock also requires a target timing adapter.
Custom build commands and verification assumptions also require a reviewed adapter.
The interface shows each gap before a run starts.
