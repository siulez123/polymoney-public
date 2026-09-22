import assert from "node:assert/strict";
import test from "node:test";
import { classifyClobResult, sanitizeClobFailureDetail } from "./secure-trading.js";

test("classifies FAK no-match responses as real liquidity failures", () => {
  assert.deepEqual(
    classifyClobResult(undefined, 400, undefined, {
      errorMsg: "no orders found to match FAK order",
      statusCode: 400,
    }),
    { resultCategory: "no_liquidity", reasonCode: "fak_no_match" },
  );
});

test("extracts nested CLOB errors returned by HTTP clients", () => {
  assert.deepEqual(
    classifyClobResult("Request failed", undefined, undefined, {
      response: { status: 422, data: { error: "order size below minimum" } },
    }),
    { resultCategory: "invalid_format", reasonCode: "below_clob_minimum" },
  );
  assert.deepEqual(
    classifyClobResult("Request failed", undefined, undefined, {
      response: { status: 401, data: { error: "invalid signature" } },
    }),
    { resultCategory: "auth_or_wallet", reasonCode: "invalid_signature_or_auth" },
  );

  const wrappedError = Object.assign(new Error("Request failed with status code 400"), {
    code: "ERR_BAD_REQUEST",
    response: { status: 400, data: { errorMsg: "no orders found to match FAK order" } },
  });
  assert.deepEqual(classifyClobResult(wrappedError.message, wrappedError.code, undefined, wrappedError), {
    resultCategory: "no_liquidity",
    reasonCode: "fak_no_match",
  });
});

test("separates known rejection families", () => {
  assert.deepEqual(classifyClobResult("invalid amounts", 400), {
    resultCategory: "invalid_format",
    reasonCode: "invalid_amounts",
  });
  assert.deepEqual(classifyClobResult("insufficient allowance", 400), {
    resultCategory: "auth_or_wallet",
    reasonCode: "insufficient_allowance",
  });
  assert.deepEqual(classifyClobResult("too many requests", 429), {
    resultCategory: "rate_limited",
    reasonCode: "rate_limited",
  });
  assert.deepEqual(classifyClobResult("internal server error", 503), {
    resultCategory: "network_or_api",
    reasonCode: "network_or_api_error",
  });
});

test("marks unknown client errors explicitly instead of generic other rejection", () => {
  assert.deepEqual(classifyClobResult("CLOB rejected order", 400), {
    resultCategory: "clob_rejected",
    reasonCode: "unclassified_client_rejection",
  });
});

test("sanitized details allowlist diagnostics and remove credentials", () => {
  const detail = sanitizeClobFailureDetail({
    response: {
      status: 401,
      data: {
        error: "unauthorized token=abc123 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        token: "must-not-appear",
        privateKey: "must-not-appear", // pragma: allowlist secret — synthetic redaction fixture
      },
    },
    headers: { authorization: "Bearer must-not-appear" },
  });

  assert.match(detail, /unauthorized/);
  assert.match(detail, /\[redacted\]/);
  assert.match(detail, /\[redacted_hex\]/);
  assert.doesNotMatch(detail, /abc123|must-not-appear/);
  assert.deepEqual(Object.keys(JSON.parse(detail)).sort(), ["message", "status"]);
});

