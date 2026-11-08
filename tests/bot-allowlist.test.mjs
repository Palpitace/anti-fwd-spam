import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, dispatch, model, setBindings, telegram } from './worker-runtime.mjs';
import { message, report } from './telegram-fake.mjs';

model.enabled = true;
const bot = { id: 7788, is_bot: true, first_name: 'Source' };
const enable = () => setBindings({ BOT_ALLOWLIST: '{"-10012":[7788]}' });
const inline = () => ({ ...message(), via_bot: bot });

for (const kind of ['inline', 'forward', 'direct', 'edit', 'basic group']) {
  test(`user: a group bot exemption skips the registered ${kind} source without punishing its caller`, async () => {
    await enable();
    const current = inline();
    if (kind === 'forward') {
      delete current.via_bot;
      current.forward_origin = { type: 'user', date: current.date, sender_user: bot };
    }
    if (kind === 'direct') { delete current.via_bot; current.from = bot; }
    if (kind === 'basic group') current.chat.type = 'group';
    if (kind === 'edit') current.edit_date = Math.floor(Date.now() / 1000);
    telegram.send(current);
    const update = { update_id: 1, [kind === 'edit' ? 'edited_message' : 'message']: current };
    assert.equal((await dispatch(update)).status, 200);
    assert.equal(telegram.has(81), true);
    assert.equal(telegram.canSend(22), true);
    assert.equal(telegram.canJoin(7788), true);
    assert.ok(await database.prepare('SELECT 1 FROM blacklisted_sources WHERE source_id = 7788').first());
  });
}

for (const scope of ['other group', 'other bot', 'removed']) {
  test(`user: bot exemptions do not spread to ${scope}`, async () => {
    await enable();
    const current = inline();
    if (scope === 'other group') {
      current.chat.id = -10013;
      telegram.groups.set(-10013, new Map([[22, { status: 'member' }], [7788, { status: 'left' }]]));
    }
    if (scope === 'other bot') {
      current.via_bot = { ...bot, id: 5566 };
      telegram.members.set(5566, { status: 'left' });
      await database.prepare('INSERT INTO blacklisted_sources (source_id) VALUES (5566)').run();
    }
    if (scope === 'removed') await setBindings({ BOT_ALLOWLIST: '{}' });
    telegram.send(current);
    assert.equal((await dispatch({ update_id: 1, message: current })).status, 200);
    assert.equal(telegram.has(81, current.chat.id), false);
    assert.equal(telegram.canSend(22, 'can_send_messages', current.chat.id), false);
    assert.equal(telegram.canJoin(current.via_bot.id, current.chat.id), false);
  });
}

for (const rule of ['other source', 'account blacklist', 'local content', 'model content', 'report', 'bs']) {
  test(`user: a bot exemption preserves ${rule} enforcement`, async () => {
    await enable();
    const current = inline();
    if (rule === 'other source') {
      current.forward_origin = { type: 'user', date: current.date, sender_user: { ...bot, id: 5566 } };
      telegram.members.set(5566, { status: 'left' });
      await database.prepare('INSERT INTO blacklisted_sources (source_id) VALUES (5566)').run();
    }
    if (rule === 'account blacklist') {
      await database.prepare('INSERT INTO blacklisted_users (bot_id,user_id,added_at) VALUES (123,22,0)').run();
    }
    if (rule === 'local content') current.text = '萝莉上门';
    if (rule === 'model content') model.probability = 1;
    telegram.send(current);
    const update = ['report', 'bs'].includes(rule) ? report(current) : { update_id: 1, message: current };
    if (rule === 'bs') {
      update.message.text = '/bs';
      update.message.entities = [{ type: 'bot_command', offset: 0, length: 3 }];
    }
    if (['report', 'bs'].includes(rule)) telegram.send(update.message);
    assert.equal((await dispatch(update)).status, 200);
    assert.equal(telegram.has(81), false);
    assert.equal(telegram.canSend(22), false);
    assert.equal(telegram.canJoin(7788), rule !== 'bs');
    if (rule === 'other source') assert.equal(telegram.canJoin(5566), false);
  });
}

test('user: a source exemption grants no reporting authority to the caller', async () => {
  await enable();
  const target = message(80, 44);
  telegram.members.set(44, { status: 'member' });
  const update = report(target);
  update.message.from = message().from;
  update.message.via_bot = bot;
  telegram.send(target);
  telegram.send(update.message);
  assert.equal((await dispatch(update)).status, 200);
  assert.equal(telegram.has(80), true);
  assert.equal(telegram.canJoin(44), true);
});

test('user: a bot source exemption does not override a joining bot blacklist', async () => {
  await enable();
  const current = { ...message(), new_chat_members: [bot] };
  delete current.text;
  telegram.send(current);
  assert.equal((await dispatch({ update_id: 1, message: current })).status, 200);
  assert.equal(telegram.canJoin(7788), false);
  assert.equal(telegram.canSend(22), true);
});

test('user: invalid bot exemption configuration rejects an update without moderation', async () => {
  await setBindings({ BOT_ALLOWLIST: '{"-10012":[true]}' });
  telegram.send(inline());
  assert.equal((await dispatch({ update_id: 1, message: inline() })).status, 500);
  assert.equal(telegram.has(81), true);
  assert.equal(telegram.canSend(22), true);
});
