import { z } from "zod";
export const profileSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(100),
    architecture: z.enum(["x86_64", "aarch64", "arm", "riscv32", "custom"]),
    operatingSystem: z.enum(["linux", "darwin", "bare-metal", "custom"]),
    board: z.string().max(200).default("generic"),
    ramMiB: z.number().positive().max(1048576),
    storageMiB: z.number().positive().max(10485760),
    maxBatchMs: z.number().positive().max(100).default(100),
    modelPolicy: z
      .enum(["auto", "build-only", "device-requested"])
      .default("auto"),
    peripherals: z.array(z.string().max(100)).max(100).default([]),
    provenance: z
      .record(
        z.string(),
        z.object({
          source: z.string().max(200),
          review: z.enum(["declared", "unreviewed", "verified"]),
        }),
      )
      .default({}),
  })
  .strict();
export type DeviceProfile = z.infer<typeof profileSchema>;
export const policySchema = z
  .object({
    version: z.literal("demo-v1").default("demo-v1"),
    maxAttempts: z.number().int().min(1).max(12).default(4),
    maxSeconds: z.number().int().min(10).max(900).default(900),
    maxTokens: z.number().int().min(1000).max(100000).default(100000),
    maxCostUsd: z.number().min(0).max(5).default(5),
    mode: z.enum(["catalog", "model"]).default("catalog"),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;
export const proposalSchema = z
  .object({
    transform: z.enum(["algebraic", "encoded", "control-flow"]),
    key: z.number().int().min(1).max(65535),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type Proposal = z.infer<typeof proposalSchema>;
export const limits = Object.freeze({
  proofSeconds: 60,
  differentialCases: 10000,
  maxBinaryBytes: 2097152,
  maxRssBytes: 67108864,
  maxBatchMs: 100,
  maxSlowdown: 5,
});
export const domain = Object.freeze({
  raw: [0, 4095],
  gain_q8: [1, 1024],
  offset: [-1024, 1024],
});
export const inputSchema = z
  .object({
    raw: z.number().int().min(0).max(4095),
    gain_q8: z.number().int().min(1).max(1024),
    offset: z.number().int().min(-1024).max(1024),
  })
  .strict();
export type State =
  | "queued"
  | "preparing"
  | "baseline"
  | "searching"
  | "verifying"
  | "evaluating"
  | "packaging"
  | "succeeded"
  | "failed"
  | "cancelled";
export const terminal = new Set<State>(["succeeded", "failed", "cancelled"]);
export type Proof = {
  state: "proved" | "counterexample" | "timeout" | "unsupported" | "tool-error";
  tool: string;
  version: string;
  assumptions: unknown;
  log: string;
  durationMs: number;
  sourceHash: string;
  harnessHash: string;
  command: string[];
};
export type Measurement = {
  binaryBytes: number;
  rssBytes: number;
  batchMs: number;
  samplesMs: number[];
  slowdown: number;
  differentialCases: number;
  differentialSeed: number;
  matches: boolean;
  limits: typeof limits;
  passed: boolean;
  assemblyChanged: boolean;
};
export type Candidate = {
  id: string;
  runId: string;
  index: number;
  origin: "injected-control" | "catalog" | "model" | "conventional";
  proposal: Proposal | null;
  source: string;
  sourceHash: string;
  binaryHash?: string;
  proof?: Proof;
  measurement?: Measurement;
  accepted: boolean;
  reason: string;
  artifacts: Record<string, string>;
};
export type Run = {
  id: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  state: State;
  profile: DeviceProfile;
  policy: Policy;
  sourceHash: string;
  profileHash: string;
  policyHash: string;
  candidates: Candidate[];
  acceptedId?: string;
  baseline?: Record<string, any>;
  artifacts: Record<string, string>;
  cancelRequested: boolean;
  elapsedMs?: number;
  error?: string;
  modelUsage: { tokens: number; costUsd: number };
  gaps: string[];
  reconstruction?: unknown;
  placement?: unknown;
  leaseUntil?: number;
};
export type RunEvent = {
  runId: string;
  sequence: number;
  time: string;
  stage: string;
  message: string;
  evidence: string[];
};
