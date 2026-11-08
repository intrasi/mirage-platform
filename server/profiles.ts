import { arch, platform } from "node:os";
import { profileSchema, type DeviceProfile } from "../shared/schema.js";
export function defaultProfiles() {
  return [
    profileSchema.parse({
      version: 1,
      name: "This computer · trusted development",
      architecture: arch() === "arm64" ? "aarch64" : "x86_64",
      operatingSystem: platform(),
      targetId: "native-development",
      board: "development-host",
      processorPart: arch(),
      toolchain: "configured-worker",
      abi: "host-native",
      byteOrder: "little",
      wordBits: 64,
      ramMiB: 64,
      storageMiB: 2,
      provenance: {
        architecture: { source: "worker host", review: "verified" },
        operatingSystem: { source: "worker host", review: "verified" },
      },
    }),
    profileSchema.parse({
      version: 1,
      name: "Linux x86-64 · hosted target",
      architecture: "x86_64",
      operatingSystem: "linux",
      targetId: "linux-x86-64",
      board: "generic-linux-vm",
      processorPart: "x86-64",
      toolchain: "configured-worker",
      abi: "System V AMD64",
      byteOrder: "little",
      wordBits: 64,
      ramMiB: 64,
      storageMiB: 2,
    }),
    profileSchema.parse({
      version: 1,
      name: "Custom toothbrush · example only",
      architecture: "arm",
      operatingSystem: "bare-metal",
      board: "fictional-toothbrush-v1",
      ramMiB: 0.25,
      storageMiB: 1,
      modelPolicy: "build-only",
      peripherals: ["motor", "pressure sensor"],
      provenance: {
        board: { source: "fictional fixture", review: "unreviewed" },
      },
    }),
  ];
}
export function placement(profile: DeviceProfile) {
  return {
    decision: ["build-only", "disabled"].includes(profile.modelPolicy)
      ? "build-time-only"
      : "unassessed",
    deviceModelIncluded: false,
    reason: ["build-only", "disabled"].includes(profile.modelPolicy)
      ? "The product specification requests build-time operation."
      : "The selected device has no complete model resource and protection assessment. Development runtime results are separate.",
    requirements: [
      "A named model and runtime adapter",
      "Measured peak memory and storage",
      "Measured timing and energy",
      "A protection benefit under equal analysis budgets",
    ],
    declaredRamMiB: profile.ramMiB,
    declaredStorageMiB: profile.storageMiB,
  };
}

// Uploaded declarations cannot grant verification status to themselves.
export function importedProfile(value: unknown) {
  const profile = profileSchema.parse(value);
  const provenance: DeviceProfile["provenance"] = {};
  const supplied = new Set<string>();
  const collect = (v: unknown, path: string) => {
    if (path) supplied.add(path);
    if (v && typeof v === "object")
      for (const [key, item] of Object.entries(v))
        if (key !== "provenance") collect(item, path ? `${path}.${key}` : key);
  };
  collect(value, "");
  const walk = (v: unknown, path: string) => {
    if (path)
      provenance[path] = {
        source:
          profile.provenance[path]?.source ||
          (supplied.has(path)
            ? "uploaded device profile"
            : "documented schema default"),
        review: "unreviewed",
      };
    if (v && typeof v === "object")
      for (const [key, item] of Object.entries(v))
        if (key !== "provenance") walk(item, path ? `${path}.${key}` : key);
  };
  walk(profile, "");
  return { ...profile, provenance };
}
export function profileCapabilities(
  profile: DeviceProfile,
  kind: string,
  target: string,
) {
  const expected = `${profile.operatingSystem}-${profile.architecture === "aarch64" ? "arm64" : profile.architecture === "x86_64" ? "x64" : profile.architecture}`;
  const gaps: string[] = [];
  if (expected !== target || (kind === "hosted" && expected !== "linux-x64"))
    gaps.push(
      "No execution adapter exists for this target. Hardware files do not create a simulator.",
    );
  for (const peripheral of profile.peripherals)
    gaps.push(`No behavior model exists for peripheral: ${peripheral}.`);
  for (const field of [
    "targetId",
    "processorPart",
    "abi",
    "toolchain",
  ] as const)
    if (!profile[field]) gaps.push(`The device profile has no ${field}.`);
  const allowedAbi =
    target === "linux-x64"
      ? ["host-native", "System V AMD64"]
      : ["host-native"];
  if (profile.abi && !allowedAbi.includes(profile.abi))
    gaps.push(
      "The requested application binary interface has no configured adapter.",
    );
  if (!["development-host", "generic-linux-vm"].includes(profile.board))
    gaps.push("The requested board has no native execution adapter.");
  if (profile.clockMHz !== undefined)
    gaps.push("A specified processor clock requires a target timing adapter.");
  if (profile.toolchain && profile.toolchain !== "configured-worker")
    gaps.push("The requested toolchain has no configured adapter.");
  if (["required", "device-requested"].includes(profile.modelPolicy))
    gaps.push(
      "This build adapter cannot include a device model. Use the separate runtime demonstration for local inference.",
    );
  if (profile.maxEnergyMillijoules !== undefined)
    gaps.push("An energy limit requires an energy measurement adapter.");
  if (profile.stackLimitBytes !== undefined || profile.memoryRegions?.length)
    gaps.push(
      "Memory layout and stack limits require a target measurement adapter.",
    );
  if (profile.buildCommands?.length || profile.verificationAssumptions.length)
    gaps.push(
      "Custom build commands and verification assumptions require a reviewed adapter.",
    );
  if (
    (profile.byteOrder && profile.byteOrder !== "little") ||
    (profile.wordBits && profile.wordBits !== 64)
  )
    gaps.push(
      "The processor word size or byte order does not match the native adapter.",
    );
  const supported = gaps.length === 0;
  return {
    supported,
    gaps,
    capabilities: {
      build: supported,
      execution: supported,
      formalChecking: supported,
      resourceMeasurement: supported,
      hardwareValidation: false,
      energyMeasurement: false,
      runtimeModelPackaging: false,
    },
  };
}
