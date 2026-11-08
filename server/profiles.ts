import { arch, platform } from "node:os";
import { profileSchema, type DeviceProfile } from "../shared/schema.js";
export function defaultProfiles() {
  return [
    profileSchema.parse({
      version: 1,
      name: "This computer · trusted development",
      architecture: arch() === "arm64" ? "aarch64" : "x86_64",
      operatingSystem: platform(),
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
    decision:
      profile.modelPolicy === "build-only"
        ? "build-time-only"
        : profile.ramMiB < 64
          ? "unsuitable-for-demo-model"
          : "unassessed",
    deviceModelIncluded: false,
    reason:
      profile.modelPolicy === "build-only"
        ? "The product specification requests build-time operation."
        : profile.ramMiB < 64
          ? "Declared memory is below the demo assessment threshold. No model was measured on this device."
          : "No model size, inference timing, energy, or protection benefit has been measured.",
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
