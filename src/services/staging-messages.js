'use strict';

const crypto = require('crypto');
const conversations = require('./conversations');

function demoUser(id, username) {
  return { id, username, avatarUrl: null };
}

const DEMO_ADA = demoUser(902783, 'staging-demo-general-ada');
const DEMO_LIN = demoUser(902784, 'staging-demo-general-lin');
const CAPTURE_ADMIN_USERNAME = 'usernode-capture-admin';
const UNREAD_CHECK_KEY = 'staging-capture-unread-check';
const UNREAD_CHECK_TITLE = 'Preview check-in';

const DEMO_SCREENSHOT_NAME = 'Screenshot 2026-08-13 at 12.44.10\u202fPM.png';
const DEMO_SCREENSHOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAaUlEQVR42u3QMQ0AAAgDsPnECsq5cMDN0aQKmurhEAWCBAkSJEiQIEEIEiRIkCBBggQhSJAgQYIECRKEIEGCBAkSJEiQIAQJEiRIkCBBghAkSJAgQYIECUKQIEGCBAkSJEgQggQJEvTPAqsgmoaz8xeCAAAAAElFTkSuQmCC',
  'base64'
);

function demoConversations(user) {
  const self = demoUser(user.id, user.username || 'you');
  const ada = DEMO_ADA;
  const lin = DEMO_LIN;
  return [
    {
      id: 910001, kind: 'direct', title: 'ada', status: 'active', archived: false,
      members: [
        { ...self, role: 'member', status: 'member', joinedAt: '2026-08-11T12:00:00Z' },
        { ...ada, role: 'member', status: 'member', joinedAt: '2026-08-11T12:01:00Z' },
      ],
      memberCount: 2, membershipStatus: 'member', myRole: 'member', requester: null, peer: ada,
      latestMessage: null, latestSummary: 'The proposal card is ready to review.',
      lastActivityAt: '2026-08-13T13:30:00Z', unreadCount: 2,
      canSend: true, canInvite: false, canManage: false,
    },
    {
      id: 910002, kind: 'group', title: 'Launch crew', status: 'active', archived: false,
      members: [
        { ...self, role: 'owner', status: 'member', joinedAt: '2026-08-10T10:00:00Z' },
        { ...ada, role: 'member', status: 'member', joinedAt: '2026-08-10T10:02:00Z' },
        { ...lin, role: 'member', status: 'member', joinedAt: '2026-08-10T10:03:00Z' },
      ],
      memberCount: 3, membershipStatus: 'member', myRole: 'owner', requester: null, peer: null,
      latestMessage: null, latestSummary: 'How the launch card looks on my phone.',
      lastActivityAt: '2026-08-13T12:52:00Z', unreadCount: 0,
      canSend: true, canInvite: true, canManage: true,
    },
    {
      id: 910003, kind: 'group', title: 'Design review', status: 'active', archived: false,
      members: [], memberCount: 4, membershipStatus: 'invited', myRole: 'member',
      requester: lin, peer: null, latestMessage: null, latestSummary: '',
      lastActivityAt: '2026-08-13T11:00:00Z', unreadCount: 0,
      canSend: false, canInvite: false, canManage: false,
    },
    {
      id: 910004, kind: 'channel', title: 'general', channelKey: 'general',
      status: 'active', archived: false,
      members: [], memberCount: 128, membershipStatus: 'member', myRole: 'member',
      requester: null, peer: null, latestMessage: null,
      latestSummary: 'Anyone else trying the new #general room?',
      lastActivityAt: '2026-08-13T13:10:00Z', unreadCount: 1,
      canSend: true, canInvite: false, canManage: false,
    },
  ];
}

function demoMessagesRaw(user, conversationId) {
  const self = demoUser(user.id, user.username || 'you');
  const ada = DEMO_ADA;
  if (conversationId === 910001) return [
    {
      // #1808: the thread's oldest row, fixed in an earlier YEAR so the
      // transcript's third stamp branch is on screen in every preview. The
      // rows below it are this year's, so one scroll of this pane shows all
      // three spellings the transcript uses. It used to print "08:40 AM"
      // here and "01:20 PM" below, with nothing to say the two were two
      // years apart.
      id: 9100100, conversationId, sender: ada,
      content: 'This is where the thread started, back in 2024.',
      createdAt: '2024-11-02T08:40:00Z', editedAt: null,
      reply: null, reactions: [], attachments: [], objects: [],
    },
    {
      // `saved: true` on exactly one demo row, so the staging preview and the
      // declared checks show BOTH states of the save button on one screen —
      // filled here, empty on every other row. The real flag is hydrated per
      // viewer in services/conversations.js; this is the ?demo=1 stand-in,
      // because `conversation_message_bookmarks` is staging:private and a
      // staging clone therefore has the table and none of the rows.
      id: 9100101, conversationId, sender: ada, saved: true,
      content: 'Can you look at the latest proposal?', createdAt: '2026-08-13T13:20:00Z', editedAt: null,
      reply: null, reactions: [{ emoji: '👍', count: 2, reacted: false, users: ['ada', self.username] }],
      attachments: [], objects: [{
        type: 'proposal', appId: 1, appSlug: 'usernode', available: true,
        sessionId: 3327, title: 'Platform Messages', subtitle: 'Homeroom', state: 'active',
        author: 'ada', href: '#app/usernode/dev/proposals/3327',
      }],
    },
    {
      id: 9100102, conversationId, sender: self,
      content: 'Yes — the consent and privacy boundary looks right.', createdAt: '2026-08-13T13:25:00Z', editedAt: '2026-08-13T13:26:00Z',
      reply: { id: 9100101, sender: ada, content: 'Can you look at the latest proposal?' },
      reactions: [], attachments: [], objects: [{
        type: 'app', appId: 1, appSlug: 'usernode', available: true,
        title: 'Homeroom', subtitle: 'Platform app', state: 'active', author: 'ada',
        href: '#app/usernode',
      }, {
        type: 'issue', appId: 1, appSlug: 'usernode', issueNumber: 488, available: true,
        title: 'Platform-wide private messaging', subtitle: 'Homeroom · Issue #488',
        state: 'open', author: 'ada', href: '#app/usernode/dev/issues/488',
      }],
    },
    {
      id: 9100103, conversationId, sender: ada,
      content: 'The proposal card is ready to review.', createdAt: '2026-08-13T13:30:00Z', editedAt: null,
      reply: null, reactions: [], attachments: [], objects: [{
        type: 'spec', appId: 1, appSlug: 'usernode', sessionId: 3327, version: 1,
        available: true, title: 'Platform Messages plan v1', subtitle: 'Homeroom',
        state: 'v1', author: 'ada', href: '#app/usernode/dev/sessions/3327',
      }, {
        type: 'governance', appId: 1, appSlug: 'usernode', proposalId: 701,
        available: true, title: 'Enable Messages rollout', subtitle: 'Homeroom governance',
        state: 'open', author: 'ada', href: '#app/usernode/dev/governance/701',
      }, { type: 'spec', available: false }],
    },
  ];
  if (conversationId === 910002) return [{
    id: 9100201, conversationId, sender: ada,
    content: 'I attached the launch checklist.', createdAt: '2026-08-13T12:45:00Z', editedAt: null,
    reply: null, reactions: [], attachments: [{
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'launch-checklist.md', size: 842,
      contentType: 'text/markdown', kind: 'markdown',
      url: `/api/conversations/${conversationId}/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?demo=1`,
      viewUrl: null,
    }, {
      // #2113: a screenshot named the way macOS names them, with a narrow
      // no-break space before "PM". Serving it used to 500 because that
      // character cannot travel in a Content-Disposition header, so the
      // preview shows the fix: the image renders instead of breaking.
      id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: DEMO_SCREENSHOT_NAME,
      size: DEMO_SCREENSHOT_PNG.length, contentType: 'image/png', kind: 'image',
      url: `/api/conversations/${conversationId}/attachments/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?demo=1`,
      viewUrl: null,
    }], objects: [],
  }, {
    // #2387: a message its author deleted — the placeholder the transcript
    // draws in its place. Sender and time stay; nothing it said does.
    id: 9100202, conversationId, sender: ada,
    content: '', createdAt: '2026-08-13T12:50:00Z', editedAt: null, deleted: true,
    reply: null, reactions: [], attachments: [], objects: [], saved: false,
  }, {
    // #4055: a picture the viewer sent, beside ada's above, so the preview
    // shows Download on both your own picture and someone else's.
    id: 9100203, conversationId, sender: self,
    content: 'How the launch card looks on my phone.', createdAt: '2026-08-13T12:52:00Z', editedAt: null,
    reply: null, reactions: [], attachments: [{
      id: 'cccccccccccccccccccccccccccccccc', name: 'launch-card-phone.png',
      size: DEMO_SCREENSHOT_PNG.length, contentType: 'image/png', kind: 'image',
      url: `/api/conversations/${conversationId}/attachments/cccccccccccccccccccccccccccccccc?demo=1`,
      viewUrl: null,
    }], objects: [],
  }];
  if (conversationId === 910004) {
    const lin = DEMO_LIN;
    // Three from ada in a row, then lin: the transcript draws ada's name and
    // face ONCE and her next two as continuation lines (#2783), which is the
    // grouping the declared checks look for.
    return [
      {
        id: 9100401, conversationId, sender: ada,
        content: 'Morning all! The Messages list is sectioned now.', createdAt: '2026-08-13T13:00:00Z', editedAt: null,
        reply: null, reactions: [{ emoji: '🎉', count: 3, reacted: false, users: ['lin'] }], attachments: [], objects: [],
      },
      {
        id: 9100402, conversationId, sender: ada,
        content: 'Direct messages and agents on top, channels underneath.', createdAt: '2026-08-13T13:01:00Z', editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [],
      },
      {
        id: 9100403, conversationId, sender: ada,
        content: 'Issue #488 has the background.', createdAt: '2026-08-13T13:02:00Z', editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [],
      },
      {
        // #2387: the demo THREAD's root. Its three replies are in
        // demoThreadReplies below; the main stream draws each as a line where
        // it landed (demoMainStream), and this summary is the card under the
        // message that opens them.
        id: 9100404, conversationId, sender: lin,
        content: 'Anyone else trying the new #general room?', createdAt: '2026-08-13T13:10:00Z', editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [],
        thread: {
          replyCount: 3, lastReplyAt: '2026-08-13T13:30:00Z',
          participants: [ada, lin],
          lastReply: {
            id: 9100413, sender: ada, content: 'And the room stays quiet while we talk.',
            createdAt: '2026-08-13T13:30:00Z',
          },
        },
      },
      {
        id: 9100405, conversationId, sender: self,
        content: 'Yes, from here.', createdAt: '2026-08-13T13:12:00Z', editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [],
      },
      // #2884: four cards in a row and nothing said between them — the run
      // the transcript draws as its first card and "… 3 more".
      ...[
        [9100406, 3327, 'Platform Messages'],
        [9100407, 3328, 'Collapse runs of cards in a channel'],
        [9100408, 3329, 'One outline on the message box'],
        [9100409, 3330, 'Messages at the list’s reading size'],
      ].map(([id, sessionId, title], index) => ({
        id, conversationId, sender: lin, content: '',
        createdAt: `2026-08-13T13:${String(14 + index).padStart(2, '0')}:00Z`, editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [{
          type: 'proposal', appId: 1, appSlug: 'usernode', available: true,
          sessionId, title, subtitle: 'Homeroom', state: 'active',
          author: 'lin', href: `#app/usernode/dev/proposals/${sessionId}`,
        }],
      })),
    ];
  }
  return [];
}

// Every demo message wears the full #2387 shape, so a client never has to
// guess at a missing `deleted` or `thread`.
function demoShape(message) {
  return { deleted: false, threadRootId: null, thread: null, ...message };
}

function demoMessages(user, conversationId) {
  return demoMessagesRaw(user, conversationId).map(demoShape);
}

// Persisted thread recipe under #general's "Anyone else trying the new
// #general room?" (9100404) — three replies from two people, the viewer's own
// in the middle so the thread shows both sides of a conversation. They land
// after the run of cards, so ids and times agree and the main stream draws
// them as ONE card of consecutive replies (the follow-up's merged line).
function demoThreadReplies(user, conversationId) {
  if (conversationId !== 910004) return [];
  const self = demoUser(user.id, user.username || 'you');
  const ada = DEMO_ADA;
  const lin = DEMO_LIN;
  const threadRoot = { id: 9100404, senderUsername: lin.username, content: 'Anyone else trying the new #general room?', deleted: false };
  const reply = (id, sender, content, createdAt) => demoShape({
    id, conversationId, sender, content, createdAt, editedAt: null,
    reply: null, reactions: [], attachments: [], objects: [], threadRootId: 9100404, threadRoot,
  });
  return [
    reply(9100411, ada, 'Yes! Threads keep the room readable.', '2026-08-13T13:21:00Z'),
    reply(9100412, lin, 'Replying here instead of in the room.', '2026-08-13T13:23:00Z'),
    reply(9100413, ada, 'And the room stays quiet while we talk.', '2026-08-13T13:30:00Z'),
  ];
}

// The main stream as the real one reads it since the #2387 follow-up: the
// conversation's messages and its threads' replies, in the order they landed.
function demoMainStream(user, conversationId) {
  return [...demoMessages(user, conversationId), ...demoThreadReplies(user, conversationId)]
    .sort((a, b) => a.id - b.id);
}

async function seedMessages(db, user, recipe, conversationId) {
  const existing = await db.query(
    "SELECT id, idempotency_key FROM conversation_messages WHERE conversation_id = $1 AND idempotency_key LIKE 'staging-inbox-%'",
    [conversationId]);
  const messageIds = new Map(existing.rows.map(row => [Number(row.idempotency_key.slice('staging-inbox-'.length)), row.id]));
  for (const message of demoMainStream(user, recipe.id)) {
    if (recipe.kind === 'channel' && message.sender.id === user.id) continue;
    const result = await db.query(
      `INSERT INTO conversation_messages
         (conversation_id, sender_id, content, idempotency_key, created_at, edited_at, reply_to_id, thread_root_id, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (conversation_id, sender_id, idempotency_key)
         WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
      [conversationId, message.sender.id, message.content, `staging-inbox-${message.id}`,
        message.createdAt, message.editedAt, messageIds.get(message.reply?.id) || null,
        messageIds.get(message.threadRootId) || null, message.deleted ? message.createdAt : null]);
    if (!result.rows[0]) continue;
    const messageId = result.rows[0].id;
    messageIds.set(message.id, messageId);
    for (const attachment of message.attachments) {
      const data = attachment.kind === 'image' ? DEMO_SCREENSHOT_PNG
        : Buffer.from('# Launch checklist\n\n- Verify consent states\n- Verify private cards\n');
      await db.query(
        `INSERT INTO conversation_message_attachments
           (id, conversation_id, message_id, user_id, kind, filename, content_type, size_bytes, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [crypto.randomBytes(16).toString('hex'), conversationId, messageId, message.sender.id,
          attachment.kind, attachment.name, attachment.contentType, data.length, data]);
    }
    if (message.saved) await db.query(
      'INSERT INTO conversation_message_bookmarks (user_id, message_id) VALUES ($1, $2)', [user.id, messageId]);
    for (const reaction of message.reactions) {
      // Every displayed reaction belongs to an actual member.
      for (const actor of [DEMO_ADA, DEMO_LIN]) {
        await db.query(
          'INSERT INTO conversation_message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
          [messageId, actor.id, reaction.emoji]);
        if (recipe.kind === 'direct') break;
      }
    }
    // Old cards claimed nonexistent proposals/specs/issues were available.
    // Share only the real platform app; retained examples of missing
    // objects go through the ordinary unavailable-card serializer.
    for (const [position, object] of message.objects.entries()) {
      const app = object.type === 'app' || (recipe.kind === 'channel' && message.id >= 9100406 && message.id <= 9100409)
        ? (await db.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id LIMIT 1')).rows[0] : null;
      const type = app ? 'app' : { proposal: 'code_proposal', governance: 'governance_proposal', issue: 'github_issue' }[object.type] || object.type;
      await db.query(
        `INSERT INTO conversation_message_objects (message_id, position, object_type, app_id, object_ref, object_version)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [messageId, position, type, app?.id || null, app?.id || 1, type === 'spec' ? 1 : null]);
    }
  }
}

// Proposal checks share one persistent capture-admin account. The routed demo
// threads below are supposed to become read when opened, so none can also be
// the durable unread fixture for list/badge checks. Give that test identity a
// real group and a real incoming message whose dynamic id is never published
// as a check route. The ordinary serializer then computes unreadCount from the
// untouched membership cursor. The per-user advisory lock held by the caller,
// plus the idempotency key, keeps this bounded to one conversation/message.
// An existing membership is recognized in any status, so leaving/removal does
// not make reconciliation create a replacement room.
async function ensureUnreadCheckFixture(db, user) {
  if (user?.username !== CAPTURE_ADMIN_USERNAME) return null;
  const existing = await db.query(
    `SELECT m.conversation_id
       FROM conversation_messages m
       JOIN conversation_members viewer
         ON viewer.conversation_id = m.conversation_id
        AND viewer.user_id = $3
      WHERE m.sender_id = $1
        AND m.idempotency_key = $2
      LIMIT 1`,
    [DEMO_ADA.id, UNREAD_CHECK_KEY, user.id]
  );
  if (existing.rows[0]) return existing.rows[0].conversation_id;

  const conversationId = (await db.query(
    `INSERT INTO conversations (kind, title, created_by, created_at, updated_at)
     VALUES ('group', $1, $2, '2026-08-13T13:35:00Z', '2026-08-13T13:35:00Z')
     RETURNING id`,
    [UNREAD_CHECK_TITLE, DEMO_ADA.id]
  )).rows[0].id;
  await db.query(
    `INSERT INTO conversation_members
       (conversation_id, user_id, role, status, invited_by, joined_at, responded_at)
     VALUES ($1, $2, 'owner', 'member', NULL, NOW(), NOW()),
            ($1, $3, 'member', 'member', $2, NOW(), NOW())`,
    [conversationId, DEMO_ADA.id, user.id]
  );
  await db.query(
    `INSERT INTO conversation_messages
       (conversation_id, sender_id, content, idempotency_key, created_at)
     VALUES ($1, $2, $3, $4, '2026-08-13T13:35:00Z')`,
    [conversationId, DEMO_ADA.id,
      'The inbox checks can use this unread preview message.', UNREAD_CHECK_KEY]
  );
  return conversationId;
}

// Serial IDs are allocated by PostgreSQL. Never assign the same private
// conversation to several viewers just to preserve a screenshot's address.
async function ensureFixtures(pool, user) {
  if (process.env.USERNODE_ENV !== 'staging' || !user?.id) return new Map();
  return conversations.transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(4781, $1)', [user.id]);
    // The four conversations of this recipe; #3624's bot DM (BOT_DM_LEGACY_ID)
    // is its own fixture, below.
    const existing = await db.query(
      'SELECT legacy_id, conversation_id FROM staging_conversation_fixtures WHERE user_id = $1 AND legacy_id <= 910004', [user.id]);
    const ids = new Map(existing.rows.map(row => [row.legacy_id, row.conversation_id]));
    let complete = false;
    if (ids.size === 4) {
      const probe = await db.query(
        `SELECT COUNT(*)::int AS count FROM conversation_messages
          WHERE (conversation_id = $1 AND idempotency_key = 'staging-inbox-9100202')
             OR (conversation_id = $2 AND idempotency_key = 'staging-inbox-9100413')`,
        [ids.get(910002), ids.get(910004)]);
      complete = probe.rows[0].count === 2;
    }
    if (complete && user.username !== CAPTURE_ADMIN_USERNAME) return ids;
    const actors = await db.query(
      `SELECT id, username FROM users WHERE id = ANY($1::int[])
        AND password = 'staging-demo-not-a-login'`, [[DEMO_ADA.id, DEMO_LIN.id]]);
    if (![DEMO_ADA, DEMO_LIN].every(actor => actors.rows.some(row => row.id === actor.id && row.username === actor.username))) {
      throw new Error('Staging message fixture accounts are missing or conflict with existing users');
    }
    await ensureUnreadCheckFixture(db, user);
    if (complete) return ids;
    for (const recipe of demoConversations(user)) {
      if (ids.has(recipe.id)) {
        await seedMessages(db, user, recipe, ids.get(recipe.id));
        continue;
      }
      let conversationId;
      let seed = true;
      if (recipe.kind === 'channel') {
        // One genuine public channel; no viewer-authored sample messages in it.
        await db.query('SELECT pg_advisory_xact_lock(4781, 0)');
        const room = await db.query("SELECT id FROM conversations WHERE channel_key = 'general' AND kind = 'channel'");
        if (!room.rows[0]) throw new Error('Staging general channel is missing');
        conversationId = room.rows[0].id;
      } else if (recipe.kind === 'direct') {
        const pair = await conversations.lockPair(db, user.id, DEMO_ADA.id);
        const prior = await db.query(
          'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2', pair);
        conversationId = prior.rows[0]?.conversation_id;
        seed = !conversationId;
        if (!conversationId) {
          conversationId = (await db.query(
            "INSERT INTO conversations (kind, created_by, created_at, updated_at) VALUES ('direct', $1, $2, $3) RETURNING id",
            [DEMO_ADA.id, '2024-11-02T08:40:00Z', recipe.lastActivityAt])).rows[0].id;
          await db.query(
            'INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id) VALUES ($1, $2, $3)',
            [conversationId, ...pair]);
        }
      } else {
        conversationId = (await db.query(
          "INSERT INTO conversations (kind, title, created_by, created_at, updated_at) VALUES ('group', $1, $2, $3, $3) RETURNING id",
          [recipe.title, recipe.membershipStatus === 'invited' ? DEMO_LIN.id : user.id, recipe.lastActivityAt])).rows[0].id;
      }
      if (seed) {
        const members = recipe.kind === 'channel'
          ? [DEMO_ADA, DEMO_LIN, user].map(actor => ({ ...actor, role: 'member', status: 'member' }))
          : recipe.membershipStatus === 'invited'
            ? [{ ...DEMO_LIN, role: 'owner', status: 'member' }, { ...DEMO_ADA, role: 'member', status: 'member' },
              { ...user, role: 'member', status: 'invited' }]
            : recipe.members;
        for (const member of members) {
          await db.query(
            `INSERT INTO conversation_members (conversation_id, user_id, role, status, invited_by, joined_at, responded_at)
             VALUES ($1, $2, $3, $4::varchar, $5, CASE WHEN $4::varchar = 'member' THEN NOW() END, CASE WHEN $4::varchar = 'member' THEN NOW() END)
             ON CONFLICT (conversation_id, user_id) DO NOTHING`,
            [conversationId, member.id, member.role, member.status, recipe.requester?.id || DEMO_ADA.id]);
        }
        await seedMessages(db, user, recipe, conversationId);
      }
      await db.query(
        'INSERT INTO staging_conversation_fixtures (user_id, legacy_id, conversation_id) VALUES ($1, $2, $3)',
        [user.id, recipe.id, conversationId]);
      ids.set(recipe.id, conversationId);
    }
    return ids;
  });
}

// #3624: the Homeroom bot's DM, with one question still open, so a staging
// preview shows the suggested answers and the line saying an answer is
// public. The bot never acts on staging (homeroom-bot-live.js isLiveFor), so
// nothing would put a question there otherwise. Obviously fake (a
// "Staging demo" project and request), never registered as a question the
// bot is waiting on: an answer tapped here gets the bot's short help, and
// nothing is posted on any request. The bot's account is the platform's own
// synthetic user, created here as a bare row when a fresh staging database
// has none.
const BOT_DM_LEGACY_ID = 910005;
const BOT_DM_QUESTION_KEY = 'staging-hrbot-question';
const BOT_DM_OFFER_KEY = 'staging-hrbot-offer';
// B3: the action id the demo offer's buttons name. No homeroom_bot_dm_actions
// row stands behind it: the action endpoint answers the demo without one.
const BOT_DM_DEMO_ACTION_ID = 990001;
const BOT_DM_ASK_KEY = 'staging-hrbot-ask';
// B6: a first version's plan, waiting for Build it, and a request the bot
// has two questions about. Fixtures too: the plan's Build it names an action
// no row stands behind, and nothing is posted on any request.
const BOT_DM_PLAN_KEY = 'staging-hrbot-plan';
const BOT_DM_PLAN_ACTION_ID = 990002;
const BOT_DM_TWO_QUESTIONS_KEY = 'staging-hrbot-two-questions';
// #4488: a complicated change's plan on a project that already exists,
// waiting for its requester's Build it, its screens on the request. A
// fixture too: Build it names an action no row stands behind.
const BOT_DM_COMPLICATED_PLAN_KEY = 'staging-hrbot-complicated-plan';
const BOT_DM_COMPLICATED_PLAN_ACTION_ID = 990003;
// 20 Oct 2026: and the plan it asks about, which its card shows: the shared
// spec version src/db/migrate.js seedStagingComplicatedPlanSpec writes.
const BOT_DM_COMPLICATED_PLAN_SPEC = Object.freeze({ sessionId: 900832, version: 1 });
// #4046: and a first version's plan its maker already built, which the
// card that follows its build sits under.
const BOT_DM_BUILT_PLAN_KEY = 'staging-hrbot-plan-built';
// B7, #3870: a change ready to try, its card saying what the change is.
// Its session id stands for no session: Try it opens nothing (the demo
// project has no slug) and Approve answers with an error, never a vote.
// #4097 follow-up: a build that did not finish, with its Try again button.
const BOT_DM_STUCK_KEY = 'staging-hrbot-build-failed';
const BOT_DM_READY_KEY = 'staging-hrbot-ready';
const BOT_DM_READY_SESSION_ID = 990901;
// #4231: a new project's first version gone live, with Open, Open community
// and Invite people. No project stands behind its slug: Open and Open
// community find nothing, and the invite sheet opens but makes no link.
const BOT_DM_FIRST_LIVE_KEY = 'staging-hrbot-first-live';
const BOT_DM_FIRST_LIVE_SLUG = 'staging-demo-plants';

async function ensureBotDmFixture(pool, user) {
  if (process.env.USERNODE_ENV !== 'staging' || !user?.id) return null;
  await pool.query(
    `INSERT INTO users (username, password, is_synthetic, display_name)
     VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
     ON CONFLICT DO NOTHING`
  );
  const bot = (await pool.query(
    `SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE`
  )).rows[0];
  if (!bot || bot.id === user.id) return null;
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, user.id);
  if (!opened) return null;
  await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
    content: '**Staging demo app** · request #12: Staging demo, sort the list by date\n\n'
      + 'I have a question before I build this:\n\nShould the newest items show first, or the oldest?',
    idempotency_key: BOT_DM_QUESTION_KEY,
  }, {
    metadata: {
      homeroomBot: {
        kind: 'question', appName: 'Staging demo app', issueNumber: 12,
        issueTitle: 'Staging demo, sort the list by date', mirrors: true, status: 'open',
        question: 'Should the newest items show first, or the oldest?',
        answers: ['Newest first', 'Oldest first', 'Let me pick each time'],
      },
    },
  });
  // #3624 stage 2: and a request it offers to file, with File it / Not now.
  // A demo: no project stands behind it, so a tap files nothing here.
  // #3707: the offer answers the viewer's ask and quotes it, as the bot's
  // answers do. A fixture whose offer is already there is left as it was,
  // rather than given an ask after its answer.
  const offered = await pool.query(
    `SELECT 1 FROM conversation_messages
      WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3`,
    [opened.conversationId, bot.id, BOT_DM_OFFER_KEY]
  );
  if (!offered.rows.length) {
    const ask = await conversations.sendMessage(pool, user, opened.conversationId, {
      content: 'Staging demo: could you add a dark mode to the list?',
      idempotency_key: BOT_DM_ASK_KEY,
    });
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: 'Here is the request I\'d file for you.\n\n**Staging demo app** · new request: Staging demo, add a dark mode\n\n'
        + 'Staging demo: a dark mode for the list, switched on from the settings screen.',
      idempotency_key: BOT_DM_OFFER_KEY,
      ...(ask?.messageId ? { reply_to_id: ask.messageId } : {}),
    }, {
      metadata: {
        homeroomBot: {
          kind: 'confirm', appName: 'Staging demo app', status: 'open', mirrors: false,
          question: 'File this as a request on Staging demo app?',
          answers: ['File it', 'Not now'],
          // B3: its buttons, as a live offer carries them (homeroom-bot-mayor.js
          // offerActions). The demo's action endpoint decides nothing.
          actionId: BOT_DM_DEMO_ACTION_ID,
          actions: [
            { id: 'yes', label: 'File it', style: 'primary', type: 'server' },
            { id: 'no', label: 'Not now', style: 'secondary', type: 'server' },
          ],
        },
      },
    });
  }
  // B6: a new project's plan, and a request with two questions. Each is
  // sent once, after what is already there.
  const sentB6 = new Set((await pool.query(
    `SELECT idempotency_key FROM conversation_messages
      WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = ANY($3::text[])`,
    [opened.conversationId, bot.id, [BOT_DM_PLAN_KEY, BOT_DM_TWO_QUESTIONS_KEY]]
  )).rows.map((row) => row.idempotency_key));
  if (!sentB6.has(BOT_DM_PLAN_KEY)) {
    // #4046: first, a plan built already, with the card that follows its
    // build under it, and the waiting plan's own card above it, as a live
    // first version has them. The plans carry their cards' steps (the
    // client draws no card beside them), which demoCards gives. Sent with
    // the waiting plan only, so an older fixture keeps its newest message.
    const activity = require('./homeroom-bot-activity');
    const dm = require('./homeroom-bot-dm');
    const built = {
      bullets: [
        'Staging demo: everyone\'s miles this week',
        'Log a run for any day',
        'Each runner\'s miles against their goal',
      ],
      questions: [{
        question: 'What counts as keeping up?',
        answers: ['Each runner picks their own goal', 'One shared club goal', 'No goals, just everyone\'s miles'],
      }],
    };
    const runClub = { appName: 'Staging demo run club', issueNumber: 1, firstVersion: true };
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: dm.planCardText({ appName: runClub.appName, plan: built }),
      idempotency_key: BOT_DM_BUILT_PLAN_KEY,
    }, {
      metadata: {
        homeroomBot: {
          kind: 'plan', ...runClub, plan: built, status: 'answered', chosen: 'build', answer: 'Build it',
          choices: [built.questions[0].answers[0]],
        },
      },
    });
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: activity.cardText(runClub, dm, { go: true }),
      idempotency_key: activity.DEMO_CARD_KEYS.building,
      // #4392: drawn as the bot's thanks for answering, as cardUnderPlan sends it.
    }, { metadata: { homeroomBot: { kind: 'activity', ...runClub, thanks: true, appEmoji: '🏃' } } });
    const plants = { appName: 'Staging demo plants', issueNumber: 1, firstVersion: true };
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: activity.cardText(plants, dm, { queued: true }),
      idempotency_key: activity.DEMO_CARD_KEYS.plan,
    }, { metadata: { homeroomBot: { kind: 'activity', ...plants } } });
    const plan = {
      bullets: [
        'Staging demo: a list of your plants with how often each needs water',
        'A Today view of the plants that need watering now',
        'Tap a plant to mark it watered; its next date moves on by itself',
      ],
      questions: [{ question: 'How should it remind you?', answers: ['In the app', 'Phone alert'] }],
    };
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: require('./homeroom-bot-dm').planCardText({ appName: 'Staging demo plants', plan }),
      idempotency_key: BOT_DM_PLAN_KEY,
    }, {
      metadata: {
        homeroomBot: {
          kind: 'plan', appName: 'Staging demo plants', issueNumber: 1, firstVersion: true,
          plan, actionId: BOT_DM_PLAN_ACTION_ID, status: 'open',
        },
      },
    });
  }
  if (!sentB6.has(BOT_DM_TWO_QUESTIONS_KEY)) {
    const lead = '**Staging demo app** · request #16: Staging demo, a weekly reminder\n\n'
      + 'I have two questions before I build this:';
    const questions = [
      { question: 'What time on Sunday?', answers: ['9 AM', '8 AM', '10 AM'] },
      { question: 'How should it remind you?', answers: ['In the app', 'Phone alert'] },
    ];
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: `${lead}\n\n1. ${questions[0].question}\n2. ${questions[1].question}`,
      idempotency_key: BOT_DM_TWO_QUESTIONS_KEY,
    }, {
      metadata: {
        homeroomBot: {
          kind: 'question', appName: 'Staging demo app', issueNumber: 16,
          issueTitle: 'Staging demo, a weekly reminder', mirrors: true, status: 'open',
          question: questions[0].question, answers: questions[0].answers, questions, lead,
        },
      },
    });
  }
  // #4488: a complicated change's plan, sent once, after what is there.
  const complicatedSent = await pool.query(
    `SELECT 1 FROM conversation_messages
      WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3`,
    [opened.conversationId, bot.id, BOT_DM_COMPLICATED_PLAN_KEY]
  );
  if (!complicatedSent.rows.length) {
    const plan = {
      bullets: [
        'Staging demo: a Leaderboard tab beside the list',
        'Points for each item you finish, counted weekly',
        'Your own place shown at the top',
      ],
      questions: [{ question: 'Who shows on the leaderboard?', answers: ['Everyone in the project', 'Only people who opt in'] }],
      complicated: true,
      spec: { ...BOT_DM_COMPLICATED_PLAN_SPEC },
    };
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: require('./homeroom-bot-dm').planCardText({ appName: 'Staging demo app', plan, issueNumber: 17 }),
      idempotency_key: BOT_DM_COMPLICATED_PLAN_KEY,
    }, {
      metadata: {
        homeroomBot: {
          kind: 'plan', appName: 'Staging demo app', issueNumber: 17, firstVersion: false,
          plan, actionId: BOT_DM_COMPLICATED_PLAN_ACTION_ID, status: 'open',
        },
      },
    });
  }
  // Homeroom bot parity (P1-P9): its three private threads, sent before the
  // ready and activity cards below so the DM's newest messages stay theirs.
  await ensureBotParityThreads(pool, { user, botId: bot.id, conversationId: opened.conversationId });
  // #3736: and two activity cards, each the bot's work on a request followed
  // in place: one that ended in a proposal, and one being built now, the
  // newest. Their state is homeroom-bot-activity.js demoCards', found by
  // these keys; no project stands behind them, so they open nothing.
  const cardKeys = require('./homeroom-bot-activity').DEMO_CARD_KEYS;
  const sentCards = await pool.query(
    `SELECT idempotency_key FROM conversation_messages
      WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = ANY($3::text[])`,
    [opened.conversationId, bot.id, [cardKeys.done, cardKeys.working]]
  );
  const sentKeys = new Set(sentCards.rows.map((row) => row.idempotency_key));
  // #3870: a change ready to try, sent just before the activity cards so the
  // one being built stays the DM's newest message. A fixture whose cards are
  // already there is left as it was rather than given a newer last message.
  if (!sentKeys.size) {
    const dm = require('./homeroom-bot-dm');
    // #4097 follow-up: a build that did not finish says what to tap, Try
    // again, rather than "reply here" with nothing to press.
    const stuck = { appName: 'Staging demo app', issueNumber: 13, issueTitle: 'Staging demo, a print view' };
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: dm.dmText('build_failed', { reason: 'the build ran past its time limit' }, stuck),
      idempotency_key: BOT_DM_STUCK_KEY,
    }, {
      metadata: {
        homeroomBot: { kind: 'build_failed', ...stuck, actions: dm.STUCK_ACTIONS.build_failed, status: 'open' },
      },
    });
    const firstLive = { appName: 'Staging demo plants', issueNumber: 1, firstVersion: true };
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: dm.mergedText({ line: dm.requestLine(firstLive), appName: firstLive.appName, live: true }),
      idempotency_key: BOT_DM_FIRST_LIVE_KEY,
    }, {
      metadata: {
        homeroomBot: {
          kind: 'merged', appSlug: BOT_DM_FIRST_LIVE_SLUG, ...firstLive, live: true,
          link: `#app/${BOT_DM_FIRST_LIVE_SLUG}`,
          actions: [
            dm.openAppAction({ slug: BOT_DM_FIRST_LIVE_SLUG, appName: firstLive.appName }),
            ...dm.firstLiveActions({ slug: BOT_DM_FIRST_LIVE_SLUG }),
          ],
        },
      },
    });
    const ready = { appName: 'Staging demo app', issueNumber: 11, issueTitle: 'Staging demo, grey out finished items' };
    const card = { approve: true, last: true };
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: dm.dmText('proposal', { sessionId: BOT_DM_READY_SESSION_ID, card }, ready),
      idempotency_key: BOT_DM_READY_KEY,
    }, {
      metadata: {
        homeroomBot: {
          kind: 'proposal', ...ready,
          ready: { group: false, last: true, waitingOn: [] },
          sessionId: BOT_DM_READY_SESSION_ID, epoch: 0,
          actions: dm.readyActions({ sessionId: BOT_DM_READY_SESSION_ID, epoch: 0, approve: true }),
          status: 'open',
          changeTitle: 'Staging demo: a calmer colour for finished items',
        },
      },
    });
  }
  for (const card of [
    { key: cardKeys.done, issueNumber: 9, issueTitle: 'Staging demo, show item counts' },
    { key: cardKeys.working, issueNumber: 14, issueTitle: 'Staging demo, show a total under the list' },
  ].filter((c) => !sentKeys.has(c.key))) {
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: `**Staging demo app** · request #${card.issueNumber}: ${card.issueTitle}\n\n`
        + 'I\'m working on this now. This card updates as I go.',
      idempotency_key: card.key,
    }, {
      metadata: {
        homeroomBot: {
          kind: 'activity', appName: 'Staging demo app', issueNumber: card.issueNumber,
          issueTitle: card.issueTitle, mirrors: true,
        },
      },
    });
  }
  await ensureBotDmStory(pool, { botId: bot.id, conversationId: opened.conversationId, cardKey: cardKeys.thread });
  await pool.query(
    `INSERT INTO staging_conversation_fixtures (user_id, legacy_id, conversation_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, legacy_id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id`,
    [user.id, BOT_DM_LEGACY_ID, opened.conversationId]
  );
  return opened.conversationId;
}

// One request, one story: a demo request whose card is the root of its
// thread, with the bot's quiet lines under it and one moment that rings (a
// question with answers to tap), which the main chat shows too, under its
// "↳ in …" label. Sent once, after what is already there, so the older
// fixture's messages and the checks that read them stay as they were.
// Obviously fake: no project or request stands behind it, nothing rings
// (notify: false) and nothing is recorded as a question the bot waits on,
// so an answer tapped here gets the bot's short help, as the fixture's other
// question does. The card's state is demoCards' (DEMO_CARD_KEYS.thread).
const BOT_DM_STORY = Object.freeze({
  appName: 'Staging demo app', issueNumber: 18, issueTitle: 'Staging demo, a weekly dinner rota',
});
// #5219: the story card names its project (the platform's own app), so its
// thread shows what people said on that request's public discussion.
const BOT_DM_STORY_LINES = Object.freeze([
  { key: 'staging-hrbot-story-origin', step: 'origin', content: 'You suggested this on Staging demo app\'s page. It\'s request #18.' },
  { key: 'staging-hrbot-story-reading', step: 'reading', content: 'Reading it.' },
  {
    key: 'staging-hrbot-story-plan', step: 'spec',
    content: 'Plan: a weekly rota on the first screen, with a reminder the day before. I\'m building it now.',
  },
  { key: 'staging-hrbot-story-built', step: 'built', content: 'Built. Testing it: its checks, and its before and after screens.' },
]);
// The two people whose words the thread shows, on the request's discussion
// (chat_messages, thread_type 'issue'). Obviously fake "Staging demo:" lines,
// keyed on their content so each is inserted once.
const BOT_DM_STORY_DISCUSSION = Object.freeze([
  { userId: DEMO_ADA.id, content: 'Staging demo: could the reminder go out the evening before too?' },
  { userId: DEMO_LIN.id, content: 'Staging demo: tried the rota, the dinner names overflow on a narrow screen.' },
]);
const BOT_DM_STORY_QUESTION_KEY = 'staging-hrbot-story-question';

async function ensureBotDmStory(pool, { botId, conversationId, cardKey }) {
  const story = BOT_DM_STORY;
  // The platform's own app, found the way this file already finds it (the
  // fixture at line 313): self_hosted marks it, not a slug read from config,
  // whose export carries the loader and not the loaded object.
  const selfApp = (await pool.query(
    'SELECT id, slug FROM apps WHERE self_hosted = TRUE ORDER BY id LIMIT 1'
  )).rows[0] || null;
  // #5219: even on a staging copy whose story card was sent before it named
  // its project, the card names it now, so its thread reads the discussion.
  if (selfApp) {
    await pool.query(
      `UPDATE conversation_messages
          SET metadata = jsonb_set(metadata, '{homeroomBot,appSlug}', to_jsonb($4::text), true)
        WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3
          AND metadata->'homeroomBot'->>'appSlug' IS NULL`,
      [conversationId, botId, cardKey, selfApp.slug]
    );
    // And the seeded discussion those words come from — before the early
    // return below, so a copy whose story card was already sent still gets
    // the two people on the request's own thread. Staging only, like the
    // rest of the fixture. The list route and the thread route both open
    // the fixture, so the insert sits under the file's per-user advisory
    // lock — its NOT EXISTS guard reads before either caller commits.
    await conversations.transaction(pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(4781, $1)', [conversationId]);
      for (const line of BOT_DM_STORY_DISCUSSION) {
        await db.query(
          `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref)
           SELECT $1, $2, $3, 'message', 'issue', $4
            WHERE NOT EXISTS (
              SELECT 1 FROM chat_messages other
               WHERE other.app_id = $1 AND other.thread_type = 'issue' AND other.thread_ref = $4
                 AND other.user_id = $2 AND other.content = $3
            )`,
          [selfApp.id, line.userId, line.content, story.issueNumber]
        );
      }
    });
  }
  const sent = await pool.query(
    `SELECT 1 FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3`,
    [conversationId, botId, cardKey]
  );
  if (sent.rows.length) return;
  const card = await conversations.sendMessage(pool, { id: botId }, conversationId, {
    content: `**${story.appName}** · request #${story.issueNumber}: ${story.issueTitle}\n\n`
      + 'I\'m working on this now. This card updates as I go.',
    idempotency_key: cardKey,
  }, {
    notify: false,
    metadata: {
      homeroomBot: {
        kind: 'activity', appName: story.appName, issueNumber: story.issueNumber,
        issueTitle: story.issueTitle, requestTitle: story.issueTitle, mirrors: true,
        ...(selfApp ? { appSlug: selfApp.slug } : {}),
      },
    },
  });
  const rootId = card?.messageId ?? card?.message?.id;
  if (!rootId) return;
  const about = {
    appName: story.appName, issueNumber: story.issueNumber, issueTitle: story.issueTitle,
    requestTitle: story.issueTitle, threadRootId: rootId,
  };
  for (const line of BOT_DM_STORY_LINES) {
    await conversations.sendMessage(pool, { id: botId }, conversationId, {
      content: line.content, idempotency_key: line.key, thread_root_id: rootId,
    }, { notify: false, metadata: { homeroomBot: { kind: 'step', step: line.step, ...about } } });
  }
  const question = 'Which night should the rota start on?';
  await conversations.sendMessage(pool, { id: botId }, conversationId, {
    content: `One thing before it's ready to try:\n\n${question}`,
    idempotency_key: BOT_DM_STORY_QUESTION_KEY,
    thread_root_id: rootId,
  }, {
    notify: false,
    metadata: {
      homeroomBot: {
        kind: 'question', ...about, mirrors: true, status: 'open',
        question, answers: ['Sunday', 'Monday', 'Let me pick each week'],
        moment: 'needs_you', said: 'question', alsoInChat: true,
      },
    },
  });
}

// Homeroom bot parity (P1-P9): three private threads with Homeroom bot, as a
// conversation there looks once it has its new cards, which a staging copy
// cannot reach any other way (the bot's model never runs there). Each is a
// thread from the bot's "+" (its line in Main, kind 'opened_thread', and its
// private_threads row), named by the viewer's first words in it, with the
// bot's replies carrying the cards as stored messages:
//   1. talking it through: the "Looked at" line and options to pick from,
//      then a question set (bot-cards/options.tsx, questions.tsx);
//   2. a batch of requests worked through at once, with its roll-up, and a
//      note added to a build that is running (batch.tsx, build-note.tsx);
//   3. an investigation that checks in for days (investigation.tsx).
// Obviously fake ("Staging demo"), with no project, batch, note or
// investigation behind the cards: a tap on one decides nothing (the demo's
// card route answers { demo }), and nothing rings (notify: false). Each
// thread is sent once, keyed on its root's idempotency key.
const PARITY_THREADS = Object.freeze([
  {
    key: 'staging-hrbot-parity-talk',
    lines: [
      { me: true, content: 'Staging demo: older notifications are grouped by day now. Could we group them another way?' },
      {
        content: 'Staging demo: today one busy change can show up in four day groups. Here are three other ways. '
          + 'Tap Show to see one, or Pick the one you want.',
        meta: {
          looked: {
            items: [
              { what: 'Read Staging demo app request #21' },
              { what: 'Read 23 files in Staging demo app' },
              { what: 'Read your last 200 notifications' },
            ],
            ms: 100000,
          },
          card: {
            type: 'options', v: 1, title: 'Ways to group older notifications', picked: null,
            options: [
              { key: 'A', title: 'By change', detail: 'One row per change, newest activity first.' },
              { key: 'B', title: 'By project, then change', detail: 'A heading per project, its changes under it.' },
              { key: 'C', title: 'Day, then change', detail: 'Days stay; a change\'s lines fold into one row.' },
            ],
          },
        },
      },
      { me: true, content: 'Staging demo: let\'s do B. Ask me anything you need first.' },
      {
        content: 'Staging demo: four things to settle before I write the request. My guess is picked; change any.',
        meta: {
          card: {
            type: 'questions', v: 1, title: 'Before I write the request', answered: null,
            questions: [
              { question: 'Where should grouping happen?', answers: ['The bell only', 'The bell and Messages'], guess: 0 },
              { question: 'A request and its change: one row?', answers: ['One row', 'Two rows'], guess: 0 },
              { question: 'A folded row shows', answers: ['The newest line', 'The newest line and who', 'A count'], guess: 1 },
              { question: 'Opening a row marks', answers: ['All of it read', 'Only what you saw'], guess: 0 },
            ],
          },
        },
      },
    ],
  },
  {
    key: 'staging-hrbot-parity-batch',
    lines: [
      { me: true, content: 'Staging demo: work through my unclaimed requests on Staging demo app. Ask me about anything unclear first.' },
      {
        content: 'Staging demo: I read all nine and started the ready ones. This card follows them until they are live.',
        meta: {
          looked: { items: [{ what: 'Read 9 Staging demo app requests' }], ms: 180000 },
          card: {
            type: 'batch', v: 1, state: 'running', batchId: 0,
            project: 'staging-demo-app', projectName: 'Staging demo app',
            requests: [
              { number: 21, title: 'Staging demo, diagrams on proposals', read: 'ready', note: null, why: null },
              { number: 22, title: 'Staging demo, cards use the space better', read: 'ready', note: null, why: null },
              { number: 23, title: 'Staging demo, checks as a progress bar', read: 'ready', note: null, why: null },
              { number: 24, title: 'Staging demo, chat keeps its scroll', read: 'ready', note: null, why: null },
              { number: 25, title: 'Staging demo, comment bar stays put', read: 'question', note: 'Should it stay open while you scroll?', why: null },
              { number: 26, title: 'Staging demo, screenshots on the request page', read: 'ready', note: null, why: null },
            ],
            counts: { total: 6, ready: 5, question: 1, person: 0, done: 0, reading: 0, underway: 0, unread: 0 },
            label: '6 requests · 5 ready · 1 question',
            raise: { perPerson: 6, proposalsPerApp: 10, as: 'owner' },
            started: [21, 22, 23, 24, 26],
            refused: [],
            rollup: { live: 1, ready: 1, checks: 1, building: 2, waiting: 0, stopped: 0, total: 5 },
            progress: [
              { number: 21, state: 'live', title: 'Staging demo, diagrams on proposals' },
              { number: 22, state: 'ready', title: 'Staging demo, cards use the space better' },
              { number: 23, state: 'checks', title: 'Staging demo, checks as a progress bar' },
              { number: 24, state: 'building', title: 'Staging demo, chat keeps its scroll' },
            ],
          },
        },
      },
      { me: true, content: 'Staging demo: for the scroll one, keep the reply box pinned too.' },
      {
        content: 'Staging demo: added to that build. It reads your note before it finishes, so it goes up for a vote with everything else.',
        meta: {
          card: {
            type: 'build_note', v: 1, state: 'delivered', noteId: 0,
            project: 'staging-demo-app', projectName: 'Staging demo app', number: 24,
            title: 'Staging demo, chat keeps its scroll', note: 'Keep the reply box pinned too.',
            deliveredAt: null,
          },
        },
      },
    ],
  },
  {
    key: 'staging-hrbot-parity-investigation',
    lines: [
      { me: true, content: 'Staging demo: keep an eye on why the sync check fails now and then, over the next few days.' },
      {
        content: 'Staging demo: day 2 update. So far it only fails when two saves land in the same second.',
        meta: {
          card: {
            type: 'investigation', v: 1, investigationId: 0, state: 'running',
            goal: 'Staging demo: find out why the sync check fails now and then.',
            project: { slug: 'staging-demo-app', name: 'Staging demo app' },
            everyHours: 6, days: 5, budgetCents: 300, spentCents: 38, model: 'DeepSeek V4.1 Flash',
            checkinsDone: 3,
            checkins: [
              { hoursAgo: 14, line: 'It failed once overnight, when two saves landed in the same second.' },
              { hoursAgo: 8, line: 'Nothing new: no failures since.' },
              { hoursAgo: 2, line: 'It failed again at 3 AM, the same way.' },
            ],
            notes: 'Staging demo notes.\nCheck-in 1: the sync check fails when two saves land in the same second.',
          },
        },
      },
    ],
  },
]);

/** Pure: a parity card with its times made real, relative to `now`. */
function parityCardAt(card, now = Date.now()) {
  if (!card) return card;
  const hours = (h) => new Date(now + h * 3600 * 1000).toISOString();
  if (card.type === 'investigation') {
    const { checkins = [], ...rest } = card;
    return {
      ...rest,
      startedAt: hours(-26), endsAt: hours(94), nextAt: hours(2),
      checkins: checkins.map(({ hoursAgo, line }) => ({ at: hours(-hoursAgo), line })),
    };
  }
  if (card.type === 'build_note') return { ...card, deliveredAt: hours(-0.2) };
  return card;
}

async function ensureBotParityThreads(pool, { user, botId, conversationId }) {
  const now = Date.now();
  for (const thread of PARITY_THREADS) {
    const sent = await pool.query(
      `SELECT id FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3`,
      [conversationId, botId, `${thread.key}-root`]
    );
    if (sent.rows.length) continue;
    const root = await conversations.sendMessage(pool, { id: botId }, conversationId, {
      content: 'New thread.', idempotency_key: `${thread.key}-root`,
    }, { notify: false, metadata: { homeroomBot: { kind: 'opened_thread', changeKind: 'any' } } });
    const rootId = root?.messageId ?? root?.message?.id;
    if (!rootId) continue;
    await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state)
       VALUES ($1, $2, $3, NULL, 'ask', 'open') ON CONFLICT (root_message_id) DO NOTHING`,
      [user.id, conversationId, rootId]
    );
    let index = 0;
    for (const line of thread.lines) {
      index += 1;
      const key = `${thread.key}-${index}`;
      if (line.me) {
        await conversations.sendMessage(pool, user, conversationId, {
          content: line.content, idempotency_key: key, thread_root_id: rootId,
        }, { notify: false });
        continue;
      }
      const meta = { kind: 'chat', ...line.meta, ...(line.meta?.card ? { card: parityCardAt(line.meta.card, now) } : {}) };
      await conversations.sendMessage(pool, { id: botId }, conversationId, {
        content: line.content, idempotency_key: key, thread_root_id: rootId,
      }, { notify: false, metadata: { homeroomBot: meta } });
    }
  }
}

// The demo of a card joining work already under way: what opening the bot's
// DM does on a live copy (homeroom-bot-activity.js catchUpCards), which a
// staging copy cannot, since the bot never works there. Opening the demo DM
// gives the demo's request #15, whose plan was begun before it had a card,
// its card at the end of the transcript, once. Like the fixture's other
// cards it stands for no request: nothing is recorded or posted, and
// demoCards says how far along it is. Only in the viewer's own fixture, and
// only once the fixture is there. Resolves { added }.
async function ensureDemoUnderWayCard(pool, user) {
  if (process.env.USERNODE_ENV !== 'staging' || !user?.id) return { added: 0 };
  const { rows: [fixture] } = await pool.query(
    `SELECT f.conversation_id, b.id AS bot_id
       FROM staging_conversation_fixtures f
       JOIN users b ON b.username = 'homeroom_bot' AND b.is_synthetic = TRUE
       JOIN conversation_members cm ON cm.conversation_id = f.conversation_id AND cm.user_id = b.id
      WHERE f.user_id = $1 AND f.legacy_id = $2`,
    [user.id, BOT_DM_LEGACY_ID]
  );
  if (!fixture) return { added: 0 };
  const activity = require('./homeroom-bot-activity');
  const { issueNumber, issueTitle, startedMinutesAgo } = activity.DEMO_UNDER_WAY;
  const startedAt = new Date(Date.now() - startedMinutesAgo * 60 * 1000).toISOString();
  const sent = await conversations.sendMessage(pool, { id: fixture.bot_id }, fixture.conversation_id, {
    content: activity.cardText({ appName: 'Staging demo app', issueNumber, issueTitle, firstVersion: false },
      require('./homeroom-bot-dm'), { joined: true }),
    idempotency_key: activity.DEMO_CARD_KEYS.underWay,
  }, {
    metadata: {
      homeroomBot: {
        kind: 'activity', appName: 'Staging demo app', issueNumber, issueTitle, mirrors: true, startedAt,
      },
    },
  });
  return { added: sent?.messageId && !sent.duplicate ? 1 : 0 };
}

async function resolveLegacyLink(pool, user, id) {
  if (process.env.USERNODE_ENV !== 'staging' || id < 910001 || id > BOT_DM_LEGACY_ID) return id;
  // A real accessible ID always wins over a historical display-only address.
  if (await conversations.loadMembership(pool, id, user.id, { allowInvited: true })) return id;
  if (id === BOT_DM_LEGACY_ID) return (await ensureBotDmFixture(pool, user)) || id;
  const ids = await ensureFixtures(pool, user);
  return ids.get(id) || id;
}

async function resolveLegacyMessageLink(pool, user, conversationId, id) {
  if (process.env.USERNODE_ENV !== 'staging' || !Number.isInteger(id)
      || ![9100100, 9100101, 9100102, 9100103, 9100201, 9100202,
        9100401, 9100402, 9100403, 9100404, 9100405, 9100406, 9100407,
        9100408, 9100409, 9100411, 9100412, 9100413].includes(id)) return id;
  const actual = await pool.query(
    'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND id = $2', [conversationId, id]);
  if (actual.rows[0]) return id;
  const stored = await pool.query(
    `SELECT id FROM conversation_messages WHERE conversation_id = $1 AND idempotency_key = $2
      AND sender_id = ANY($3::int[])`,
    [conversationId, `staging-inbox-${id}`, [user.id, DEMO_ADA.id, DEMO_LIN.id]]);
  return stored.rows[0]?.id || id;
}

module.exports = {
  ensureFixtures, ensureBotDmFixture, ensureDemoUnderWayCard, resolveLegacyLink, resolveLegacyMessageLink,
  demoConversations, demoMessages, BOT_DM_LEGACY_ID,
};
