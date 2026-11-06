import { test } from "node:test";
import assert from "node:assert/strict";
import { AiNetworkError, fetchWithRetry, isNetworkFailure, networkErrorCode } from "../net.ts";

function fetchFail(code: string | null): Error {
  const cause = code ? Object.assign(new Error("underlying"), { code }) : undefined;
  return Object.assign(new TypeError("fetch failed"), { cause });
}

test("isNetworkFailure：识别 undici 的连接层失败，放过其它错误", () => {
  assert.equal(isNetworkFailure(fetchFail("ECONNRESET")), true);
  assert.equal(isNetworkFailure(fetchFail(null)), true);
  assert.equal(isNetworkFailure(new TypeError("invalid url")), false, "不是 fetch failed 就别管");
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(isNetworkFailure(abort), false);
  const notTransient = fetchFail("CERT_HAS_EXPIRED");
  assert.equal(isNetworkFailure(notTransient), false, "证书类错误重试也没用");
});

test("networkErrorCode 把 cause.code 取出来", () => {
  assert.equal(networkErrorCode(fetchFail("ENOTFOUND")), "ENOTFOUND");
  assert.equal(networkErrorCode(new Error("plain")), null);
});

test("fetchWithRetry：第一次连接被重置，重试后成功", async () => {
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    if (calls === 1) throw fetchFail("ECONNRESET");
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const res = await fetchWithRetry(fake, "https://example.test/x", { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(calls, 2, "应当重试一次");
});

test("fetchWithRetry：一直失败 → 抛 AiNetworkError，人话里带原因", async () => {
  const fake = (async () => {
    throw fetchFail("ECONNRESET");
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => fetchWithRetry(fake, "https://example.test/x", {}, 1),
    (err: unknown) => {
      assert.ok(err instanceof AiNetworkError);
      assert.equal((err as AiNetworkError).code, "AI_NETWORK");
      assert.equal((err as AiNetworkError).causeCode, "ECONNRESET");
      assert.match((err as Error).message, /连接被对端重置/);
      assert.match((err as Error).message, /重试 1 次/);
      return true;
    },
  );
});

test("fetchWithRetry：非网络错误不重试，原样抛出", async () => {
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    throw new TypeError("invalid url");
  }) as unknown as typeof fetch;
  await assert.rejects(() => fetchWithRetry(fake, "x", {}), TypeError);
  assert.equal(calls, 1);
});

test("fetchWithRetry：用户取消（signal 已 abort）不重试", async () => {
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    throw fetchFail("ECONNRESET");
  }) as unknown as typeof fetch;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => fetchWithRetry(fake, "x", { signal: controller.signal }));
  assert.equal(calls, 1);
});

test("fetchWithRetry：HTTP 4xx/5xx 不当作网络错误", async () => {
  const fake = (async () => new Response("bad", { status: 500 })) as unknown as typeof fetch;
  const res = await fetchWithRetry(fake, "x", {});
  assert.equal(res.status, 500, "响应拿得到就交给调用方判断");
});
