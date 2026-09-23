import test from "node:test";
import assert from "node:assert/strict";

import {
  authenticateExtension,
  validatePayload,
  checkSensitiveLeaks
} from "../routes/agent.js";

import { getAgentAction, ACTION_TOOLS } from "../services/vlmClient.js";

function mockResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    }
  };
  return res;
}

test("Server Auth - Rejects missing or invalid x-extension-token", () => {
  process.env.EXTENSION_SHARED_SECRET = "test-secret-12345";

  // Case 1: Missing token
  const reqMissing = { headers: {} };
  const resMissing = mockResponse();
  let nextCalled = false;
  authenticateExtension(reqMissing, resMissing, () => { nextCalled = true; });
  assert.equal(resMissing.statusCode, 401);
  assert.equal(nextCalled, false);

  // Case 2: Wrong token
  const reqWrong = { headers: { "x-extension-token": "wrong-secret" } };
  const resWrong = mockResponse();
  authenticateExtension(reqWrong, resWrong, () => { nextCalled = true; });
  assert.equal(resWrong.statusCode, 401);
  assert.equal(nextCalled, false);

  // Case 3: Valid token
  const reqValid = { headers: { "x-extension-token": "test-secret-12345" } };
  const resValid = mockResponse();
  authenticateExtension(reqValid, resValid, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("Server Guard - Defense-in-depth leak detector", () => {
  // Case 1: Leaked sensitive plain text
  const reqLeaked = {
    body: {
      domSummary: [
        { agentId: "el-1", sensitive: true, text: "4111-2222-3333-4444" }
      ]
    }
  };
  const resLeaked = mockResponse();
  let nextCalled = false;
  checkSensitiveLeaks(reqLeaked, resLeaked, () => { nextCalled = true; });
  assert.equal(resLeaked.statusCode, 400);
  assert.match(resLeaked.body.error, /unredacted sensitive field/);
  assert.equal(nextCalled, false);

  // Case 2: Properly redacted sensitive field
  const reqClean = {
    body: {
      domSummary: [
        { agentId: "el-1", sensitive: true, text: "[REDACTED]" },
        { agentId: "el-2", sensitive: false, text: "Search Button" }
      ]
    }
  };
  const resClean = mockResponse();
  checkSensitiveLeaks(reqClean, resClean, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("Server Payload - Validation rules", () => {
  // Missing task
  const reqNoTask = { body: { task: "" } };
  const resNoTask = mockResponse();
  validatePayload(reqNoTask, resNoTask, () => {});
  assert.equal(resNoTask.statusCode, 400);

  // Oversized task (>1000 chars)
  const reqLongTask = { body: { task: "a".repeat(1005) } };
  const resLongTask = mockResponse();
  validatePayload(reqLongTask, resLongTask, () => {});
  assert.equal(resLongTask.statusCode, 400);

  // Valid payload
  let nextCalled = false;
  const reqValid = { body: { task: "Search for hotels", domSummary: [] } };
  const resValid = mockResponse();
  validatePayload(reqValid, resValid, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("VLM Client - Mock Mode action conforms to tool schema", async () => {
  const context = {
    task: "Click submit",
    domSummary: [
      { agentId: "agent-el-0", tag: "button", text: "Submit Order", sensitive: false }
    ],
    history: []
  };

  const action = await getAgentAction(context);
  assert.ok(action, "Action returned");
  assert.ok(["click", "scroll", "type", "none"].includes(action.type));
  assert.ok(typeof action.reasoning === "string");
  assert.equal(action.targetId, "agent-el-0");
  assert.equal(action.type, "click");
});
