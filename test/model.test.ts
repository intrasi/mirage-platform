import test from "node:test";
import assert from "node:assert/strict";
import { propose } from "../server/model.js";
import { policySchema } from "../shared/schema.js";
import { allowedSource, createRemoteWorker } from "../server/remote-worker.js";
import { original, transform } from "../server/sample.js";
const keys = [
  "MIRAGE_MODEL_URL",
  "MIRAGE_MODEL_KEY",
  "MIRAGE_MODEL_ID",
  "MIRAGE_MODEL_INPUT_USD_PER_MILLION",
  "MIRAGE_MODEL_OUTPUT_USD_PER_MILLION",
];
test("provider fixture validates proposals, records usage, and reserves failed request costs", async () => {
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    MIRAGE_MODEL_URL: "https://provider.example/chat",
    MIRAGE_MODEL_KEY: "fixture-only",
    MIRAGE_MODEL_ID: "fixture-model",
    MIRAGE_MODEL_INPUT_USD_PER_MILLION: "1",
    MIRAGE_MODEL_OUTPUT_USD_PER_MILLION: "2",
  });
  try {
    const usage = { tokens: 0, costUsd: 0 };
    const mock = async (_url: any, init: any) => {
      const request = JSON.parse(init.body);
      assert.equal(request.model, "fixture-model");
      assert.ok(request.max_tokens <= 512);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  transform: "encoded",
                  key: 731,
                  reason: "Fixture proposal.",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 300, completion_tokens: 50 },
        }),
      );
    };
    const r = await propose(
      [],
      policySchema.parse({}),
      usage,
      undefined,
      mock as typeof fetch,
    );
    assert.equal(r.proposal.transform, "encoded");
    assert.equal(usage.tokens, 350);
    assert.ok(Math.abs(usage.costUsd - 0.0004) < 1e-8);
    const failed = { tokens: 0, costUsd: 0 };
    await assert.rejects(
      propose(
        [],
        policySchema.parse({}),
        failed,
        undefined,
        (async () => new Response("{}", { status: 503 })) as typeof fetch,
      ),
      /503/,
    );
    assert.ok(failed.tokens > 0);
    assert.ok(failed.costUsd > 0);
    let called = false;
    await assert.rejects(
      propose(
        [],
        policySchema.parse({ maxCostUsd: 0 }),
        { tokens: 0, costUsd: 0 },
        undefined,
        (async () => {
          called = true;
          return new Response("{}");
        }) as typeof fetch,
      ),
      /budget/,
    );
    assert.equal(called, false);
    await assert.rejects(
      propose(
        [],
        policySchema.parse({}),
        { tokens: 0, costUsd: 0 },
        undefined,
        (async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
          )) as typeof fetch,
      ),
      /token accounting/,
    );
  } finally {
    for (const k of keys) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
  }
});
test("worker rejects arbitrary code and unauthenticated execution", async () => {
  assert.equal(allowedSource(original), true);
  assert.equal(
    allowedSource(transform({ transform: "encoded", key: 42, reason: "test" })),
    true,
  );
  assert.equal(allowedSource(original + "\nvoid attack(void){}"), false);
  const app = createRemoteWorker("test-worker-token");
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/build",
          payload: { source: original },
        })
      ).statusCode,
      401,
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/build",
      headers: { authorization: "Bearer test-worker-token" },
      payload: { source: "int main(){return 0;}" },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /trusted calibration/);
  } finally {
    await app.close();
  }
});
