import { randomBytes } from "node:crypto";
import { hash } from "./config.js";
import { cases } from "./sample.js";
type Formula = {
  shift: number;
  rounding: "half" | "floor";
  offsetSign: number;
  ceiling: number;
};
function calculate(f: Formula, x: number[]) {
  return Math.max(
    0,
    Math.min(
      f.ceiling,
      Math.floor(
        (x[0] * x[1] + (f.rounding === "half" ? 2 ** f.shift / 2 : 0)) /
          2 ** f.shift,
      ) +
        f.offsetSign * x[2],
    ),
  );
}
// The analyst receives only a callable shipped executable and the public input interface.
// It never receives original source, verifier evidence, or held-out answers.
export async function reconstruct(
  binaryHash: string,
  oracle: (x: number[][]) => Promise<number[]>,
) {
  const start = performance.now();
  const observations = cases(96, 151119).slice(-96);
  const answers = await oracle(observations);
  let hypothesis: Formula | undefined;
  let tested = 0;
  for (let shift = 0; shift <= 16 && !hypothesis; shift++)
    for (const rounding of ["floor", "half"] as const)
      for (const offsetSign of [-1, 0, 1])
        for (const ceiling of [255, 1023, 4095, 65535]) {
          const f = { shift, rounding, offsetSign, ceiling };
          tested++;
          if (observations.every((x, i) => calculate(f, x) === answers[i])) {
            hypothesis = f;
            break;
          }
        }
  const frozen = JSON.stringify(
    hypothesis || { failure: "No matching formula in the analyst family." },
  );
  const frozenHash = hash(frozen);
  const frozenAt = new Date().toISOString();
  // Generate judge inputs only after the analyst output is frozen.
  const seed = randomBytes(4).readUInt32LE();
  const heldout = cases(1000, seed);
  const expected = await oracle(heldout);
  const matched = hypothesis
    ? heldout.filter((x, i) => calculate(hypothesis!, x) === expected[i]).length
    : 0;
  return {
    binaryHash,
    analyst: "procedural-black-box-family-search-v1",
    mode: "real executable queries; no language model",
    budget: { seconds: 300, maxTokens: 20000 },
    used: {
      seconds: (performance.now() - start) / 1000,
      tokens: 0,
      oracleInputs: observations.length,
    },
    hypothesesTested: tested,
    frozenOutput: frozen,
    frozenHash,
    frozenAt,
    heldout: {
      seed,
      cases: heldout.length,
      matched,
      generatedAfterFreeze: true,
    },
    recovered: !!hypothesis && matched === heldout.length,
    limitations:
      "This narrow analyst searches a declared arithmetic family. It does not measure resistance to general reverse engineering or AI analysis.",
  };
}
