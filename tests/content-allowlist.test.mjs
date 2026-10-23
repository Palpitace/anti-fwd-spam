import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, dispatch, model, outboundRequests, setBindings, task, telegram, tick } from './worker-runtime.mjs';
import { message, report } from './telegram-fake.mjs';

model.enabled = true;
const allowlist = '{"-10012":[22,33]}';
const enable = () => setBindings({ CONTENT_ALLOWLIST: allowlist });
const spam = '萝莉上门';
const busy = () => Response.json({ ok: false, error_code: 429 }, { status: 429 });
function join(id = 22, name = 'New member', actor = 11) {
  const notice = { ...message(81, actor), new_chat_members: [{ ...message(1, id).from, first_name: name }] };
  delete notice.text;
  return { update_id: 1, message: notice };
}

for (const field of ['text', 'caption', 'nickname', 'biography', 'model', 'sticker-set', 'sticker']) {
  test(`user: group content exemptions skip ${field} checks without deleting or restricting`, async () => {
    await enable();
    const current = message();
    model.probability = 1;
    if (field === 'text') current.text = spam;
    if (field === 'caption') { delete current.text; current.caption = spam; }
    if (field === 'nickname') current.from.first_name = spam;
    if (field === 'biography') model.profile = { bio: spam };
    if (field.startsWith('sticker')) {
      delete current.text;
      current.sticker = { set_name: 'ExampleSet', file_unique_id: 'example_sticker' };
      const table = field === 'sticker-set' ? 'blacklisted_sticker_sets' : 'blacklisted_stickers';
      const column = field === 'sticker-set' ? 'set_name' : 'file_unique_id';
      const value = field === 'sticker-set' ? 'exampleset' : 'example_sticker';
      await database.prepare(`INSERT INTO ${table} (bot_id, ${column}, added_at) VALUES (123, ?, 0)`).bind(value).run();
    }
    telegram.send(current);
    assert.equal((await dispatch({ update_id: 1, message: current })).status, 200);
    assert.equal(telegram.has(81), true);
    assert.equal(telegram.canSend(22), true);
    assert.equal(telegram.canJoin(22), true);
    assert.deepEqual(outboundRequests, []);
    assert.equal(await task(), null);
  });
}

test('user: the second configured member is exempt and ordinary edits remain exempt', async () => {
  await enable();
  telegram.members.set(33, { status: 'member' });
  const current = { ...message(81, 33), text: spam, edit_date: Math.floor(Date.now() / 1000),
    quote: { text: 'some context' } };
  telegram.send(current);
  assert.equal((await dispatch({ update_id: 2, edited_message: current })).status, 200);
  assert.equal(telegram.has(81), true);
  assert.equal(telegram.canSend(33), true);
  assert.deepEqual(outboundRequests, []);
});

for (const scope of ['other group', 'other member', 'reporter only', 'bot sender', 'sender chat', 'referenced author']) {
  test(`user: a content exemption does not spread to ${scope}`, async () => {
    await setBindings({ CONTENT_ALLOWLIST: allowlist,
      REPORTER_IDS: scope === 'reporter only' ? '11,-10012,44' : '11,-10012' });
    const current = { ...message(), text: spam };
    if (scope === 'other group') {
      current.chat.id = -10013;
      telegram.groups.set(-10013, new Map([[22, { status: 'member' }]]));
    } else if (scope === 'bot sender') current.from.is_bot = true;
    else if (scope === 'sender chat') current.sender_chat = { id: -10099, type: 'channel' };
    else {
      current.from = message(1, 44).from;
      telegram.members.set(44, { status: 'member' });
      if (scope === 'referenced author') current.reply_to_message = message(80, 22);
    }
    telegram.send(current);
    assert.equal((await dispatch({ update_id: 1, message: current })).status, 200);
    assert.equal(telegram.has(81, current.chat.id), false);
    if (!['bot sender', 'sender chat'].includes(scope)) {
      assert.equal(telegram.canSend(current.from.id, 'can_send_messages', current.chat.id), false);
    }
  });
}

for (const command of ['report', 'bs', 'allow']) {
  test(`user: exempt members do not acquire ${command} permissions`, async () => {
    await enable();
    telegram.members.set(44, { status: command === 'allow' ? 'kicked' : 'member' });
    const update = report(message(80, 44));
    update.message.from = message().from;
    if (command !== 'report') {
      update.message.text = command === 'bs' ? '/bs @example_bot' : '/allow 44';
      update.message.entities = [{ type: 'bot_command', offset: 0, length: command === 'bs' ? 3 : 6 }];
    }
    telegram.accounts.set('@example_bot', { id: 5566, type: 'private', username: 'example_bot' });
    telegram.send(update.message);
    telegram.send(update.message.reply_to_message);
    assert.equal((await dispatch(update)).status, 200);
    assert.equal(telegram.has(80), true);
    assert.equal(telegram.canJoin(44), command !== 'allow');
    assert.equal(await database.prepare('SELECT 1 FROM blacklisted_sources WHERE source_id = 5566').first(), null);
    assert.equal(telegram.replies.length, 0);
  });
}

for (const rule of ['report', 'account blacklist', 'source blacklist']) {
  test(`user: ${rule} still moderates an exempt sender`, async () => {
    await enable();
    const current = message();
    if (rule === 'account blacklist') {
      await database.prepare('INSERT INTO blacklisted_users (bot_id,user_id,added_at) VALUES (123,22,0)').run();
    }
    if (rule === 'source blacklist') current.via_bot = { id: 7788, is_bot: true, first_name: 'Source' };
    telegram.send(current);
    const update = rule === 'report' ? report(current) : { update_id: 1, message: current };
    if (rule === 'report') telegram.send(update.message);
    assert.equal((await dispatch(update)).status, 200);
    assert.equal(telegram.has(81), false);
    assert.equal(telegram.canSend(22), false);
    if (rule === 'source blacklist') assert.equal(telegram.canJoin(7788), false);
    else assert.equal(telegram.canJoin(22), false);
  });
}

for (const field of ['nickname', 'biography', 'model']) {
  test(`user: exempt joiners skip ${field} checks and keep their notice`, async () => {
    await enable();
    model.probability = 1;
    model.profile = { bio: spam };
    const update = join(22, field === 'nickname' ? spam : 'New member');
    telegram.send(update.message);
    assert.equal((await dispatch(update)).status, 200);
    assert.equal(telegram.has(81), true);
    assert.equal(telegram.canJoin(22), true);
    assert.deepEqual(outboundRequests, []);
    assert.equal((await task()).phase, 'done');
  });
}

test('user: an exempt inviter and joiner do not exempt other members in the same notice', async () => {
  await enable();
  telegram.members.set(44, { status: 'member' });
  const update = join(22, spam, 33);
  update.message.new_chat_members.push({ ...message(1, 44).from, first_name: spam });
  telegram.send(update.message);
  assert.equal((await dispatch(update)).status, 200);
  assert.equal(telegram.canJoin(22), true);
  assert.equal(telegram.canJoin(44), false);
  assert.equal(telegram.has(81), false);
});

for (const list of ['account', 'source']) {
  test(`user: the explicit ${list} blacklist still bans an exempt joiner`, async () => {
    await enable();
    if (list === 'account') {
      await database.prepare('INSERT INTO blacklisted_users (bot_id,user_id,added_at) VALUES (123,22,0)').run();
    } else await database.prepare('INSERT INTO blacklisted_sources (source_id) VALUES (22)').run();
    const update = join();
    telegram.send(update.message);
    assert.equal((await dispatch(update)).status, 200);
    assert.equal(telegram.canJoin(22), false);
    assert.equal(telegram.has(81), false);
    assert.equal(model.state, null);
  });
}

for (const joining of [false, true]) {
  for (const stage of ['classification', 'punishment']) {
    test(`user: adding an exemption stops pending ${joining ? 'join' : 'message'} ${stage} retries`, async () => {
      model.probability = 1;
      if (stage === 'classification') model.response = new Response('busy', { status: 503 });
      else telegram.faults.set(joining ? 'banChatMember' : 'deleteMessage', busy);
      const update = joining ? join() : { update_id: 1, message: message() };
      telegram.send(update.message);
      assert.equal((await dispatch(update)).status, 200);
      const pending = await task();
      assert.equal(pending.phase, stage === 'classification' ? 'classify' : 'delete');
      await enable();
      model.response = null;
      telegram.faults.clear();
      outboundRequests.length = 0;
      await tick(pending.due_at);
      assert.equal(telegram.has(81), true);
      assert.equal(telegram.canSend(22), true);
      assert.equal(telegram.canJoin(22), true);
      assert.equal((await task()).phase, 'done');
      assert.equal((await task()).input_json, null);
      assert.deepEqual(outboundRequests, []);
      // Removing the exemption must not resurrect the already cancelled decision.
      await setBindings({ CONTENT_ALLOWLIST: '' });
      await tick(pending.due_at + 300);
      assert.equal(telegram.has(81), true);
    });
  }
}

test('user: adding an exemption stops a pending mute but cannot restore its deleted message', async () => {
  model.probability = 1;
  telegram.faults.set('restrictChatMember', busy);
  telegram.send(message());
  await dispatch({ update_id: 1, message: message() });
  const pending = await task();
  assert.equal(telegram.has(81), false);
  assert.equal(telegram.canSend(22), true);
  await enable();
  telegram.faults.clear();
  await tick(pending.due_at);
  assert.equal(telegram.has(81), false);
  assert.equal(telegram.canSend(22), true);
  assert.equal((await task()).phase, 'done');
});

for (const joining of [false, true]) {
  test(`user: without models, exempt ${joining ? 'join' : 'message'} retries are cancelled while others stay paused`, async () => {
    model.response = new Response('busy', { status: 503 });
    telegram.members.set(44, { status: 'member' });
    telegram.groups.set(-10013, new Map([[22, { status: 'member' }]]));
    const updates = [
      joining ? join(44) : { message: message(80, 44) },
      joining ? join(22) : { message: message(81, 22) },
      joining ? join(22) : { message: message(82, 22) },
    ];
    const row = update => database.prepare('SELECT * FROM model_tasks WHERE chat_id = ? AND message_id = ?')
      .bind(update.message.chat.id, update.message.message_id).first();
    for (const [index, update] of updates.entries()) {
      update.update_id = index + 1;
      update.message.message_id = 80 + index;
      if (index === 2) update.message.chat.id = -10013;
      telegram.send(update.message);
      assert.equal((await dispatch(update)).status, 200);
    }
    const initial = await Promise.all(updates.map(row));
    for (const pending of initial) {
      assert.equal(pending.phase, 'classify');
      assert.equal(pending.attempts, 1);
    }
    await setBindings({ EXPERIENTIAL_API_KEY: undefined, CONTENT_ALLOWLIST: allowlist });
    outboundRequests.length = 0;
    const due = Math.max(...initial.map(pending => pending.due_at));
    await tick(due);
    const cancelled = await row(updates[1]);
    assert.equal(cancelled.phase, 'done');
    assert.equal(cancelled.input_json, null);
    for (const index of [0, 2]) assert.deepEqual(await row(updates[index]), initial[index]);
    assert.deepEqual(outboundRequests, []);
    await tick(due + 60);
    for (const index of [0, 2]) assert.deepEqual(await row(updates[index]), initial[index]);
    await setBindings({ CONTENT_ALLOWLIST: '' });
    model.response = null;
    model.probability = 1;
    await tick(due + 120);
    assert.deepEqual(await row(updates[1]), cancelled);
    assert.equal(telegram.has(81), true);
    assert.equal(telegram.canSend(22), true);
    assert.equal(telegram.canJoin(22), true);
    for (const index of [0, 2]) {
      assert.equal((await row(updates[index])).phase, 'done');
      assert.equal(telegram.has(updates[index].message.message_id, updates[index].message.chat.id), false);
    }
  });
}

for (const list of ['account', 'source']) {
  test(`user: without models, an exempt joiner on the ${list} blacklist retains the paused classification`, async () => {
    model.response = new Response('busy', { status: 503 });
    const update = join();
    telegram.send(update.message);
    await dispatch(update);
    const initial = await task();
    assert.equal(initial.phase, 'classify');
    if (list === 'account') {
      await database.prepare('INSERT INTO blacklisted_users (bot_id,user_id,added_at) VALUES (123,22,0)').run();
    } else await database.prepare('INSERT INTO blacklisted_sources (source_id) VALUES (22)').run();
    await setBindings({ EXPERIENTIAL_API_KEY: undefined, CONTENT_ALLOWLIST: allowlist });
    outboundRequests.length = 0;
    await tick(initial.due_at);
    assert.deepEqual(await task(), initial);
    assert.deepEqual(outboundRequests, []);
    await enable();
    model.response = null;
    await tick(initial.due_at + 60);
    assert.equal((await task()).phase, 'done');
    assert.equal(telegram.canJoin(22), false);
  });
}

test('user: an exempt edit cancels an earlier queued decision before the retry', async () => {
  model.response = new Response('busy', { status: 503 });
  telegram.send(message());
  await dispatch({ update_id: 1, message: message() });
  const pending = await task();
  await enable();
  const edited = { ...message(), text: spam, edit_date: Math.floor(Date.now() / 1000), quote: { text: 'context' } };
  assert.equal((await dispatch({ update_id: 2, edited_message: edited })).status, 200);
  model.response = null;
  model.probability = 1;
  await tick(pending.due_at);
  assert.equal(telegram.has(81), true);
  assert.equal(telegram.canSend(22), true);
});

test('user: removing an exemption restores checks for subsequent messages', async () => {
  await enable();
  const first = { ...message(), text: spam };
  telegram.send(first);
  await dispatch({ update_id: 1, message: first });
  await setBindings({ CONTENT_ALLOWLIST: '{}' });
  const next = { ...message(82), text: spam };
  telegram.send(next);
  assert.equal((await dispatch({ update_id: 2, message: next })).status, 200);
  assert.equal(telegram.has(81), true);
  assert.equal(telegram.has(82), false);
  assert.equal(telegram.canSend(22), false);
});

test('user: malformed allowlist configuration rejects the update without external operations', async () => {
  await setBindings({ CONTENT_ALLOWLIST: '{"-10012":[true]}' });
  assert.equal((await dispatch({ update_id: 1, message: message() })).status, 500);
  assert.deepEqual(outboundRequests, []);
});

test('user: an exempt reporter retains the authority to report another member', async () => {
  await setBindings({ CONTENT_ALLOWLIST: allowlist, REPORTER_IDS: '22' });
  telegram.members.set(44, { status: 'member' });
  const update = report(message(80, 44));
  update.message.from = message().from;
  telegram.send(update.message);
  telegram.send(update.message.reply_to_message);
  assert.equal((await dispatch(update)).status, 200);
  assert.equal(telegram.canJoin(44), false);
  assert.equal(telegram.canSend(22), true);
});

test('user: the same joiner is still checked outside their exempt group', async () => {
  await enable();
  const update = join(22, spam);
  update.message.chat.id = -10013;
  telegram.groups.set(-10013, new Map([[22, { status: 'member' }]]));
  telegram.send(update.message);
  assert.equal((await dispatch(update)).status, 200);
  assert.equal(telegram.canJoin(22, -10013), false);
  assert.equal(telegram.has(81, -10013), false);
});

test('user: a blacklist join-ban retry remains effective after adding a content exemption', async () => {
  await database.prepare('INSERT INTO blacklisted_users (bot_id,user_id,added_at) VALUES (123,22,0)').run();
  telegram.faults.set('banChatMember', busy);
  const update = join();
  telegram.send(update.message);
  await dispatch(update);
  const pending = await task();
  assert.equal(pending.phase, 'delete');
  await enable();
  telegram.faults.clear();
  await tick(pending.due_at);
  assert.equal(telegram.canJoin(22), false);
  assert.equal(telegram.has(81), false);
});

test('user: an exemption also stops an immediate-rule webhook redelivery after a failed deletion', async () => {
  const current = { ...message(), text: spam };
  telegram.send(current);
  telegram.faults.set('deleteMessage', busy);
  assert.equal((await dispatch({ update_id: 1, message: current })).status, 503);
  await enable();
  telegram.faults.clear();
  assert.equal((await dispatch({ update_id: 1, message: current })).status, 200);
  assert.equal(telegram.has(81), true);
  assert.equal(telegram.canSend(22), true);
});

test('user: configuring an exemption does not restore existing restrictions or remove blacklists', async () => {
  telegram.members.set(22, { status: 'restricted', permissions: { can_send_messages: false } });
  await database.prepare('INSERT INTO blacklisted_users (bot_id,user_id,added_at) VALUES (123,33,0)').run();
  await enable();
  const current = { ...message(), text: spam };
  telegram.send(current);
  assert.equal((await dispatch({ update_id: 1, message: current })).status, 200);
  assert.equal(telegram.has(81), true);
  assert.equal(telegram.canSend(22), false);
  assert.ok(await database.prepare('SELECT 1 FROM blacklisted_users WHERE bot_id = 123 AND user_id = 33').first());
  assert.deepEqual(outboundRequests, []);
});
