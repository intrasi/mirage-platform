import { z } from "zod";

// Public inspection metadata. Source, weights, and execution keys are excluded.
export const runtimeSymbolsSchema = z
  .object({
    format: z.literal("mirage-public-symbols-v1"),
    epoch: z.number().int().nonnegative(),
    regions: z
      .array(
        z
          .object({
            region: z.number().int().min(0).max(3),
            version: z.number().int().nonnegative(),
            function_name: z.string().max(512).nullable(),
            symbols: z.array(z.string().max(512)).max(32),
            ciphertext_sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .length(4),
  })
  .strict();

export type RuntimeSymbols = z.infer<typeof runtimeSymbolsSchema>;
