import {
  proposalSchema,
  type Proposal,
  type Policy,
} from "../shared/schema.js";
import { original } from "./sample.js";
export const catalog: Proposal[] = [
  {
    transform: "encoded",
    key: 731,
    reason: "Encode the rounding constant through a volatile mask.",
  },
  {
    transform: "control-flow",
    key: 8191,
    reason: "Use two equivalent paths for the scaled value.",
  },
  {
    transform: "algebraic",
    key: 17,
    reason: "Split multiplication and rounding into quotient and remainder.",
  },
];
export function modelConfiguration() {
  const {
    MIRAGE_MODEL_URL: url,
    MIRAGE_MODEL_KEY: key,
    MIRAGE_MODEL_ID: model,
  } = process.env;
  const inputPrice = Number(process.env.MIRAGE_MODEL_INPUT_USD_PER_MILLION),
    outputPrice = Number(process.env.MIRAGE_MODEL_OUTPUT_USD_PER_MILLION);
  let validEndpoint = false;
  try {
    const endpoint = new URL(url || "");
    validEndpoint =
      endpoint.protocol === "https:" &&
      !endpoint.username &&
      !endpoint.password;
  } catch {}
  const configured =
    validEndpoint &&
    !!url &&
    !!key &&
    !!model &&
    !!process.env.MIRAGE_MODEL_INPUT_USD_PER_MILLION?.trim() &&
    !!process.env.MIRAGE_MODEL_OUTPUT_USD_PER_MILLION?.trim() &&
    Number.isFinite(inputPrice) &&
    inputPrice >= 0 &&
    Number.isFinite(outputPrice) &&
    outputPrice >= 0;
  return { configured, url, key, model, inputPrice, outputPrice };
}
export async function propose(
  feedback: unknown[],
  policy: Policy,
  usage: { tokens: number; costUsd: number },
  signal?: AbortSignal,
  transport: typeof fetch = fetch,
  onAccounting: () => void = () => {},
): Promise<{
  proposal: Proposal;
  tokens: number;
  costUsd: number;
  model: string;
  transcript: unknown;
}> {
  const messages = [
    {
      role: "system",
      content:
        'Select one transformation for the owned calibration demonstration. Return only JSON: {"transform":"algebraic"|"encoded"|"control-flow","key":integer 1..65535,"reason":string}. You cannot modify contracts, tests, source files, or limits. Use tool feedback to improve the next candidate.',
    },
    { role: "user", content: JSON.stringify({ source: original, feedback }) },
  ];
  const result = await complete(
    messages,
    policy,
    usage,
    signal,
    transport,
    onAccounting,
  );
  const proposal = proposalSchema.parse(
    JSON.parse(
      result.content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
    ),
  );
  return { ...result, proposal };
}
export async function complete(
  messages: { role: string; content: string }[],
  policy: Pick<Policy, "maxTokens" | "maxCostUsd">,
  usage: { tokens: number; costUsd: number },
  signal?: AbortSignal,
  transport: typeof fetch = fetch,
  onAccounting: () => void = () => {},
) {
  const c = modelConfiguration();
  if (!c.configured)
    throw new Error(
      "Model endpoint, credential, identifier, and prices must be configured.",
    );
  const endpoint = new URL(c.url!);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw new Error(
      "Model endpoint requires HTTPS without embedded credentials.",
    );
  const prompt = JSON.stringify(messages);
  const reserveInput = Buffer.byteLength(prompt) + 128;
  const outputTokens = 512;
  const reserve =
    (reserveInput * c.inputPrice) / 1e6 + (outputTokens * c.outputPrice) / 1e6;
  if (
    usage.tokens + reserveInput + outputTokens > policy.maxTokens ||
    usage.costUsd + reserve > policy.maxCostUsd
  )
    throw new Error("Model request would exceed the remaining budget.");
  usage.tokens += reserveInput + outputTokens;
  usage.costUsd += reserve;
  onAccounting();
  const r = await transport(c.url!, {
    method: "POST",
    headers: {
      authorization: `Bearer ${c.key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: c.model,
      messages,
      max_tokens: outputTokens,
      temperature: 0.2,
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000),
    redirect: "error",
  });
  if (!r.ok)
    throw new Error(
      `Model provider returned ${r.status}. Reserved cost: ${reserve.toFixed(6)} USD.`,
    );
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of r.body! as any) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024)
      throw new Error("Model response exceeded its size limit.");
    chunks.push(chunk);
  }
  const data: any = JSON.parse(Buffer.concat(chunks).toString());
  const u = data.usage;
  if (
    !u ||
    !Number.isInteger(u.prompt_tokens) ||
    !Number.isInteger(u.completion_tokens) ||
    u.prompt_tokens < 0 ||
    u.completion_tokens < 0
  )
    throw new Error("Model response has no valid token accounting.");
  const tokens = u.prompt_tokens + u.completion_tokens;
  const costUsd =
    (u.prompt_tokens * c.inputPrice) / 1e6 +
    (u.completion_tokens * c.outputPrice) / 1e6;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length > 16000)
    throw new Error("Model response has no valid proposal.");
  usage.tokens += tokens - reserveInput - outputTokens;
  usage.costUsd += costUsd - reserve;
  onAccounting();
  if (usage.tokens > policy.maxTokens || usage.costUsd > policy.maxCostUsd)
    throw new Error(
      "Provider usage exceeded the declared request budget. No candidate will be accepted.",
    );
  return {
    content,
    tokens,
    costUsd,
    model: c.model!,
    transcript: {
      messages,
      response: content,
      usage: u,
      model: c.model,
      settings: { temperature: 0.2, maxOutputTokens: outputTokens },
      reserveInput,
      reserve,
    },
  };
}
