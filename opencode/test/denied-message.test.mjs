// A blocked tool call reaches the model with probe mode's reason, not the
// host's bare "Permission denied: edit".
//
//   node --test opencode/test/denied-message.test.mjs
//
// OpenCode 2.2 wraps the permission rejection in a ToolError whose own message
// is generic ("Unable to edit <path>"), and shows the model the wrapped error
// whenever there is one. These stand-ins reproduce that shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodeHarness } from '../../test/fixtures/harness.mjs';

class ToolError extends Error {
  constructor({ message, error }) { super(message); this.error = error; }
}
class PermissionRejected extends Error {}

async function withArmed(fn) {
  const h = await createOpencodeHarness();
  try {
    await h.run({ sessionID: 's1', prompt: { text: 'is X faster?' } });
    await fn(h);
  } finally { h.close(); }
}

const failedEdit = (inner) => ({
  sessionID: 's1', tool: 'edit', status: 'error',
  input: { path: 'C:/proj/README.md' },
  error: new ToolError({ message: 'Unable to edit C:/proj/README.md', error: inner }),
});

test('a denied edit is replaced by the probe reason, with no wrapped error left', () => withArmed(async (h) => {
  const event = failedEdit(new PermissionRejected('Permission denied: edit'));
  await h.afterTool(event);
  assert.ok(event.error instanceof ToolError, 'still the host error class');
  assert.equal(event.error.error, undefined);
  assert.match(event.error.message, /Blocked by probe mode/);
  assert.match(event.error.message, /README\.md/);
}));

test('a denied shell command gets the shell reason', () => withArmed(async (h) => {
  const event = {
    sessionID: 's1', tool: 'shell', status: 'error', input: { command: 'git commit -m x' },
    error: new ToolError({ message: 'Unable to run command', error: new PermissionRejected('Permission denied: shell') }),
  };
  await h.afterTool(event);
  assert.match(event.error.message, /git commit -m x/);
  assert.equal(event.error.error, undefined);
}));

test('a denial in the outer message still counts when the wrapped error is about something else', () => withArmed(async (h) => {
  const event = failedEdit(new Error('socket hang up'));
  event.error.message = 'Permission denied: edit';
  await h.afterTool(event);
  assert.match(event.error.message, /Blocked by probe mode/);
}));

test('an edit that failed for another reason is left alone', () => withArmed(async (h) => {
  const inner = new Error('ENOENT: no such file');
  const event = failedEdit(inner);
  const original = event.error;
  await h.afterTool(event);
  assert.equal(event.error, original);
  assert.equal(event.error.error, inner);
  assert.equal(event.error.message, 'Unable to edit C:/proj/README.md');
}));
