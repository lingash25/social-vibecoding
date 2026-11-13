'use strict';

const crypto = require('crypto');
const { ALLOWED_KINDS } = require('./mobile-push-preferences');
const notifyCopy = require('./homeroom-bot-notify-copy');
const { PARKED_NOTIFICATION_KINDS } = require('./kudos-parked');
const pushText = require('./push-text');

const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const RECIPIENT_CONTEXT = 'usernode-social-push-recipient-v1';
const PUSH_ENV_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// #5249: kinds whose feature is parked. No phone is woken for one: the
// worker settles such a delivery as kind_not_allowed and buildMessage
// refuses it. The set is services/kudos-parked.js's PARKED_NOTIFICATION_KINDS,
// the same one the bell's list and its unread count skip, so it empties when
// that switch (and the client's, frontend/src/features/leaderboard/
// kudos-parked.ts) goes back to false.
const PARKED_PUSH_KINDS = new Set(PARKED_NOTIFICATION_KINDS);

function isPushParked(kind) {
  return PARKED_PUSH_KINDS.has(kind);
}

function isPushEnvironment(value) {
  return typeof value === 'string' && PUSH_ENV_RE.test(value);
}

function recipientBinding({ installationId, userId, environment }) {
  const installation = String(installationId || '').toLowerCase();
  const user = String(userId || '');
  if (!installation || !/^[1-9]\d*$/.test(user) || !environment) {
    throw new Error('mobile_push_recipient_binding_invalid');
  }
  return crypto.createHash('sha256')
    .update([RECIPIENT_CONTEXT, installation, user, environment].join('\n'))
    .digest('hex');
}

// ── Contextual notification copy (#3289) ───────────────────────────────
// The visible title/body are built per kind from send-time context loaded
// by the worker (same joins as the in-app dropdown). The `data` payload
// stays opaque — context feeds ONLY the display strings. Anything missing
// or malformed degrades to the generic copy; copy assembly never throws,
// so a context problem can never kill a delivery.
//
// The fixed words are frontend/locales/en/push.json, whole messages asked for
// by id, so Homeroom's translation step fills them like the rest of its text.
// `t` is pushText.english unless the worker has one for the recipient's language
// (push-language.js). Names, titles, quoted words and the bot's own words are
// parameters or pass through as written. What only a full admin receives
// (platformIncidentCopy, platformLimitCopy) stays English here, like the admin
// console it points at.

const TITLE_MAX = 80;
const BODY_MAX = 140;
const EMBED_TITLE_MAX = 60;
// #1688: a voter's one-line reason, quoted as the vote push's body. Two
// characters short of BODY_MAX for the quotation marks around it.
const VOTE_REASON_EMBED_MAX = 138;
// Labels embedded in a TITLE get a tighter cap than body embeds, so the
// actor and the ` · App` suffix survive the final 80-char truncation.
const TITLE_EMBED_MAX = 40;
// What a push says when nothing else can be said, and what that is when not
// even the catalog can be read: genericCopy asks the catalog first, for the
// same words.
const GENERIC_COPY = Object.freeze({ title: 'Homeroom', body: 'You have new activity' });

// dev/evan-1786562509265 and friends: a trailing run of digits marks a
// machine-generated branch name, which reads as noise in a push. Such a
// branch never becomes a label; the kind's no-label wording renders instead.
const GENERATED_BRANCH_RE = /\d{6,}$/;

// #6494: a storage detail token carries MiB used and MiB of cap. The push
// says the same figures the drawer does: MB below 1 GiB, else GB with at
// most one decimal ("1.6 GB", "3 GB").
function storageSizeText(mib) {
  const n = Number(mib);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${Math.round(n)} MB`;
  return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} GB`;
}

// Push text is plain and single-line: drop control chars, collapse runs of
// whitespace. Returns '' for anything that is not a usable string.
function cleanText(value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// B4: a chat message's markdown, read as the words it shows. A push is
// plain text, and "**Plant Pal** · request #4" spent half its body on
// asterisks. Links keep their words, code its text, a heading or a quote its
// line. Returns '' for anything that is not a string.
function plainMarkdown(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/`+([^`\n]*)`+/g, '$1')
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?)/gm, '');
}

// B4 / "one story": the Homeroom bot's moments, and its answer to what
// somebody just wrote to it, as notifications.detail carries them
// (homeroom-bot-dm.js notificationDetail). The words are
// homeroom-bot-notify-copy.js's: the request and its project over what
// happened, instead of "@homeroom_bot replied to you" over the start of its
// message. The bell words the same detail
// (frontend/src/features/notifications/notifications.js), and
// tests/homeroom-bot-notify.test.js holds the two together.
function botMomentCopy(detail, message) {
  const copy = notifyCopy.botMomentCopy(detail, message);
  if (!copy || !copy.body) return null;
  return { title: copy.title, body: copy.body };
}

// WP-E: the bot's build moments as their own kinds ("Your builds"). Worded
// by the moment the detail names, like its messages above; these are what a
// row without one says, and they are the bot's words too.
const BUILD_FALLBACK = Object.freeze({
  build_ready: 'Ready to try. Try it, and approve it if you\'re happy.',
  build_needs_you: 'I need your answer before I go on.',
  build_stopped: 'Stopped. I said why in our chat.',
  build_live: 'It\'s live.',
});

// "One story": a change named the way every ping names it, "{change title}
// · {project}". '' without a title.
function changeTitle(label, app, t) {
  if (!label) return '';
  const title = truncate(label, TITLE_EMBED_MAX);
  return app ? t('push:join.app', { title, app }) : title;
}

function truncate(value, max) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

const AUTO_SOLVE_BODIES = Object.freeze({
  spec: 'push:autoSolve.done.body.spec',
  code: 'push:autoSolve.done.body.code',
  spec_code: 'push:autoSolve.done.body.specCode',
});

function daysSince(value, now) {
  const elapsed = new Date(now).getTime() - new Date(value || NaN).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.floor(elapsed / (24 * 60 * 60 * 1000));
}

// #1405. Same shape as daysSince, at the grain path B's copy needs: this is a
// nudge measured in minutes, not a proposal going stale over days.
function minutesSince(value, now) {
  const elapsed = new Date(now).getTime() - new Date(value || NaN).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.floor(elapsed / (60 * 1000));
}

// services/platform-limit-alerts.js detailToken(): "<limit>_<level>:<used>:<cap>".
// Parsed here rather than required from there: that module reaches the
// database helpers, and copy assembly stays dependency-free.
const PLATFORM_LIMIT_DETAIL_RE = /^(apps|sessions|github|github_app)_(warn|full):(\d{1,7}):(\d{1,7})$/;

// services/platform-incident-alerts.js tokens (#4296), parsed here for the
// same reason: "digest:<total>:<kind>=<n>,..." or "hour:<kind>:<n>".
const INCIDENT_DIGEST_RE = /^digest:(\d{1,5}):((?:[a-z][a-z0-9_]{0,23}=\d{1,5})(?:,[a-z][a-z0-9_]{0,23}=\d{1,5})*)?$/;
const INCIDENT_HOUR_RE = /^hour:([a-z][a-z0-9_]{0,23}):(\d{1,5})$/;

function incidentKindLabel(kind) {
  return String(kind).replace(/_/g, ' ');
}

// services/platform-signals.js: a problem the platform filed for a person,
// on its own board or, for a private kind (a security finding), as a private
// request only admins see. The push names neither the private request's
// title nor what it is about: a lock screen is not private.
const INCIDENT_SIGNAL_RE = /^signal:(\d{1,9})$/;
const INCIDENT_PRIVATE_RE = /^private:(\d{1,10})$/;

function platformIncidentCopy(detail) {
  const signal = INCIDENT_SIGNAL_RE.exec(detail);
  if (signal) {
    return {
      title: 'A platform problem needs a person',
      body: `Homeroom filed request #${signal[1]} on its own board from its own records`,
    };
  }
  if (INCIDENT_PRIVATE_RE.test(detail)) {
    return {
      title: 'A private platform request needs a person',
      body: 'Homeroom filed it privately: open Private requests in its Workshop',
    };
  }
  const hour = INCIDENT_HOUR_RE.exec(detail);
  if (hour) {
    const [, kind, n] = hour;
    return {
      title: 'Unexpected events piling up',
      body: `${n} ${incidentKindLabel(kind)} in the last hour. Admin \u2192 Unexpected events has each one`,
    };
  }
  const digest = INCIDENT_DIGEST_RE.exec(detail);
  if (!digest) {
    return { title: 'Unexpected events', body: 'Open Admin \u2192 Unexpected events to see what happened' };
  }
  const total = Number(digest[1]);
  const parts = digest[2] ? digest[2].split(',').map((p) => p.split('=')) : [];
  const listed = parts.reduce((sum, [, n]) => sum + Number(n), 0);
  const kinds = parts.map(([kind, n]) => `${incidentKindLabel(kind)} ${n}`);
  if (total > listed) kinds.push(`other ${total - listed}`);
  return {
    title: `${total} unexpected event${total === 1 ? '' : 's'} yesterday`,
    body: kinds.length ? kinds.join(', ') : 'Open Admin \u2192 Unexpected events to see what happened',
  };
}

function platformLimitCopy(detail) {
  const m = PLATFORM_LIMIT_DETAIL_RE.exec(detail);
  if (!m) {
    return {
      title: 'Platform limit',
      body: 'The server is nearing one of its limits. Open Homeroom to see which',
    };
  }
  const [, limit, level, used, cap] = m;
  // GitHub's hourly budget (services/github-budget.js): the bot token's,
  // which nearly every GitHub call spends, or the GitHub App's.
  if (limit === 'github') {
    return level === 'full'
      ? { title: 'GitHub requests used up',
        body: `All ${cap} of this hour's GitHub requests are used. Proposals and shots that need GitHub fail until the hour resets` }
      : { title: 'GitHub requests running low',
        body: `${used} of ${cap} GitHub requests used this hour. Background work waits so people's work keeps the rest` };
  }
  if (limit === 'github_app') {
    return level === 'full'
      ? { title: 'GitHub App requests used up',
        body: `All ${cap} of this hour's GitHub App requests are used. It resets within the hour` }
      : { title: 'GitHub App requests running low',
        body: `${used} of ${cap} GitHub App requests used this hour` };
  }
  if (limit === 'apps') {
    return level === 'full'
      ? { title: 'App limit reached',
        body: `${used} of ${cap} apps are in use. New apps are refused until the limit is raised in Admin \u2192 Limits` }
      : { title: 'Nearing the app limit',
        body: `${used} of ${cap} apps are in use. Raise the limit in Admin \u2192 Limits before new apps are refused` };
  }
  return level === 'full'
    ? { title: 'Session limit reached',
      body: `${used} of ${cap} coding sessions are running. New ones pause idle sessions or wait until the limit is raised in Admin \u2192 Limits` }
    : { title: 'Nearing the session limit',
      body: `${used} of ${cap} coding sessions are running. At the limit, idle sessions are paused to make room` };
}

// Kind-specific {title, body}, or null when the kind's essential context is
// missing (e.g. a mention without a sender) — null means the generic copy.
function buildCopy(kind, context, now, t) {
  const app = cleanText(context.appName);
  const conversation = cleanText(context.conversationTitle);
  const actor = cleanText(context.sourceUsername);
  const message = cleanText(plainMarkdown(context.messageContent));
  const detail = cleanText(context.detail);
  // B4: only the platform's own account (the Homeroom bot) words a message
  // by its moment; anybody else's message is theirs, as written.
  if (context.sourceIsSynthetic === true
    && (kind === 'conversation_message' || kind === 'conversation_reply' || kind === 'conversation_mention')) {
    const bot = botMomentCopy(detail, message);
    if (bot) return bot;
  }
  if (Object.prototype.hasOwnProperty.call(BUILD_FALLBACK, kind)) {
    return botMomentCopy(detail, message) || { title: 'Homeroom bot', body: BUILD_FALLBACK[kind] };
  }
  // #971 preference order, same as the in-app dropdown renderers — except
  // that a machine-generated branch name is worse than no label at all.
  const branch = cleanText(context.branchName);
  const label = cleanText(context.sessionTitle) || cleanText(context.prTitle)
    || (GENERATED_BRANCH_RE.test(branch) ? '' : branch);
  const withApp = (title) => (app ? t('push:join.app', { title, app }) : title);
  const withConversation = (title) => (conversation ? t('push:join.conversation', { title, conversation }) : title);
  // The label as a body and as a title show it: a title's is shorter.
  const bodyLabel = label ? truncate(label, EMBED_TITLE_MAX) : '';
  const titleLabel = label ? truncate(label, TITLE_EMBED_MAX) : '';
  switch (kind) {
    case 'test_alert':
      return { title: t('push:testAlert.title'), body: t('push:testAlert.body') };
    case 'conversation_invite':
      return {
        title: withConversation(actor ? t('push:conversationInvite.title.person', { actor })
          : t('push:conversationInvite.title.unnamed')),
        body: t('push:conversationInvite.body'),
      };
    case 'conversation_message':
      return {
        title: withConversation(actor ? t('push:conversationMessage.title.person', { actor })
          : t('push:conversationMessage.title.unnamed')),
        body: message,
      };
    case 'conversation_mention':
      return actor && {
        title: withConversation(t('push:conversationMention.title', { actor })),
        body: message,
      };
    case 'conversation_reply':
      return actor && {
        title: withConversation(t('push:conversationReply.title', { actor })),
        body: message,
      };
    // #2387: the thread is the news, so the title says where it happened.
    case 'conversation_thread_reply':
      return actor && {
        title: withConversation(t('push:conversationThreadReply.title', { actor })),
        body: message,
      };
    case 'conversation_reaction':
      return actor && {
        title: withConversation(detail
          ? t('push:conversationReaction.title.emoji', { actor, reaction: detail })
          : t('push:conversationReaction.title.plain', { actor })),
        body: message && t('push:conversationReaction.body', { message }),
      };
    // #2386. No app, no conversation: the person IS the news. The body says
    // what to do about it, because the row it opens carries the buttons.
    case 'friend_request':
      return actor && {
        title: t('push:friendRequest.title', { actor }),
        body: t('push:friendRequest.body'),
      };
    case 'friend_accept':
      return actor && {
        title: t('push:friendAccept.title', { actor }),
        body: t('push:friendAccept.body'),
      };
    case 'mention':
      return actor && {
        title: withApp(titleLabel
          ? t('push:mention.title.named', { actor, title: titleLabel }) : t('push:mention.title.plain', { actor })),
        body: message,
      };
    // #3952: named with @ in a request somebody filed. `detail` is its number.
    case 'issue_mention': {
      const numbered = /^\d+$/.test(detail);
      return actor && {
        title: withApp(numbered
          ? t('push:issueMention.title.numbered', { actor, number: detail })
          : t('push:issueMention.title.plain', { actor })),
        body: t('push:issueMention.body'),
      };
    }
    case 'reply':
      return actor && {
        title: withApp(titleLabel
          ? t('push:reply.title.named', { actor, title: titleLabel }) : t('push:reply.title.plain', { actor })),
        body: message,
      };
    // #2387: somebody answered in an app-chat reply thread you are in. The
    // reply itself is the body, like a reply to you.
    case 'thread_reply':
      return actor && {
        title: withApp(t('push:threadReply.title', { actor })),
        body: message,
      };
    // #4535: somebody posted in a request's discussion you filed or posted
    // in. `detail` is the request's number, so the title says which one;
    // without it, "a request". The reply itself is the body.
    case 'issue_thread_reply': {
      const numbered = /^\d+$/.test(detail);
      return actor && {
        title: withApp(numbered
          ? t('push:issueThreadReply.title.numbered', { actor, number: detail })
          : t('push:issueThreadReply.title.plain', { actor })),
        body: message,
      };
    }
    // #6019: the same in a thread a change or a decision leads. `detail` is
    // the change's number; a decision filed as a governance row has none.
    case 'change_thread_reply': {
      const numbered = /^\d+$/.test(detail);
      return actor && {
        title: withApp(numbered
          ? t('push:changeThreadReply.title.numbered', { actor, number: detail })
          : t('push:changeThreadReply.title.decision', { actor })),
        body: message,
      };
    }
    // A person's message in a small private group's discussion
    // (services/group-channel-notify.js). Only a fresh row rings, so this is
    // nearly always the one message; `detail` counts the messages folded in
    // since, should the row have grown before the push went out.
    case 'channel_message': {
      const count = /^\d{1,6}$/.test(detail) ? Number(detail) : 1;
      const place = app ? truncate(app, TITLE_EMBED_MAX) : '';
      if (count > 1) {
        return {
          title: place
            ? t('push:channelMessage.many.title.where', { count, place })
            : t('push:channelMessage.many.title', { count }),
          body: actor && message ? t('push:channelMessage.many.body', { actor, message }) : message,
        };
      }
      return actor && {
        title: place
          ? t('push:channelMessage.one.title.where', { actor, place })
          : t('push:channelMessage.one.title', { actor }),
        body: message,
      };
    }
    case 'reaction':
      return actor && {
        title: withApp(detail
          ? t('push:reaction.title.emoji', { actor, reaction: detail })
          : t('push:reaction.title.plain', { actor })),
        body: message && t('push:reaction.body', { message }),
      };
    case 'kudos':
      return actor && {
        title: withApp(titleLabel
          ? t('push:kudos.title.named', { actor, title: titleLabel }) : t('push:kudos.title.plain', { actor })),
        body: t('push:kudos.body'),
      };
    // WP-E: what an invite link brought back to its maker
    // (services/invite-activity.js). A push is only ever the day's first of
    // each; the bell counts the rest. An open is never anybody's name.
    case 'invite_opened':
      return {
        title: app ? t('push:inviteOpened.title.app', { app }) : t('push:inviteOpened.title.plain'),
        body: t('push:inviteOpened.body'),
      };
    case 'member_joined':
      return actor && {
        title: app ? t('push:memberJoined.title.app', { actor, app }) : t('push:memberJoined.title.plain', { actor }),
        body: t('push:memberJoined.body'),
      };
    case 'first_message':
      return actor && {
        title: app ? t('push:firstMessage.title.app', { actor, app }) : t('push:firstMessage.title.plain', { actor }),
        body: message,
      };
    // The leaked-link guard (services/community-invites.js GUARD): one link
    // brought in a lot of people today, or paused itself. `detail` is
    // "<inviteId>:<joins>" (invite-activity.js noteGuard).
    case 'invite_link_busy':
    case 'invite_link_paused': {
      const joins = /^\d{1,9}:(\d{1,9})$/.exec(detail);
      const count = joins ? Number(joins[1]) : 0;
      if (kind === 'invite_link_busy') {
        return {
          title: app ? t('push:inviteLinkBusy.title.app', { app, count }) : t('push:inviteLinkBusy.title.plain', { count }),
          body: t('push:inviteLinkBusy.body'),
        };
      }
      return {
        title: app ? t('push:inviteLinkPaused.title.app', { app }) : t('push:inviteLinkPaused.title.plain'),
        body: t('push:inviteLinkPaused.body', { count }),
      };
    }
    // An invite into a private project is to join it (detail 'join',
    // services/collab-invites.js); the rest are to build one.
    case 'collab_invite':
      if (detail === 'join') {
        return {
          title: actor
            ? (app ? t('push:collabInvite.join.title.app', { actor, app }) : t('push:collabInvite.join.title.plain', { actor }))
            : withApp(t('push:collabInvite.join.title.unnamed')),
          body: t('push:collabInvite.join.body'),
        };
      }
      return {
        title: actor
          ? (app ? t('push:collabInvite.build.title.app', { actor, app }) : t('push:collabInvite.build.title.plain', { actor }))
          : withApp(t('push:collabInvite.build.title.unnamed')),
        body: t('push:collabInvite.build.body'),
      };
    case 'collab_invite_accepted':
      return actor && {
        title: withApp(t('push:collabInviteAccepted.title', { actor })),
        body: t('push:collabInviteAccepted.body'),
      };
    case 'approver_invite':
      return {
        title: withApp(actor ? t('push:approverInvite.title.person', { actor }) : t('push:approverInvite.title.unnamed')),
        body: t('push:approverInvite.body'),
      };
    case 'approver_invite_accepted':
      return actor && {
        title: withApp(t('push:approverInviteAccepted.title', { actor })),
        body: t('push:approverInviteAccepted.body'),
      };
    case 'spec_shared':
      return {
        title: withApp(actor
          ? (titleLabel ? t('push:specShared.title.named', { actor, title: titleLabel }) : t('push:specShared.title.plain', { actor }))
          : t('push:specShared.title.unnamed')),
        body: detail ? t('push:specShared.body.version', { version: detail }) : t('push:specShared.body.plain'),
      };
    case 'session_done':
      return {
        title: withApp(t('push:sessionDone.title')),
        body: bodyLabel && t('push:sessionDone.body', { title: bodyLabel }),
      };
    // #3181: the turn ended on an error, a timeout or a lost worker, or the
    // platform paused the session mid-turn. The title says what happened and
    // where; the body is the one thing to do about it.
    case 'session_stalled':
      return {
        title: app
          ? t('push:sessionStalled.title.app', { app: truncate(app, TITLE_EMBED_MAX) })
          : t('push:sessionStalled.title.plain'),
        body: bodyLabel ? t('push:sessionStalled.body.named', { title: bodyLabel }) : t('push:sessionStalled.body.plain'),
      };
    case 'auto_solve_done': {
      if (detail === 'question') {
        return {
          title: withApp(t('push:autoSolve.question.title')),
          body: bodyLabel ? t('push:autoSolve.question.body.named', { title: bodyLabel })
            : t('push:autoSolve.question.body.plain'),
        };
      }
      if (detail === 'failed') {
        return {
          title: withApp(t('push:autoSolve.failed.title')),
          body: bodyLabel ? t('push:autoSolve.failed.body.named', { title: bodyLabel })
            : t('push:autoSolve.failed.body.plain'),
        };
      }
      return {
        title: withApp(titleLabel ? t('push:autoSolve.done.title.named', { title: titleLabel }) : t('push:autoSolve.done.title.plain')),
        body: Object.prototype.hasOwnProperty.call(AUTO_SOLVE_BODIES, detail) ? t(AUTO_SOLVE_BODIES[detail]) : '',
      };
    }
    // B7 / "one story": the change and its project over who asked for it
    // and what to do ("Water reminders · Plant Pal" over "@ben's change is
    // ready to try. Try it and vote.").
    case 'change_ready':
      return {
        title: changeTitle(label, app, t) || t('push:changeReady.title'),
        body: actor ? t('push:changeReady.body.person', { actor }) : t('push:changeReady.body.unnamed'),
      };
    case 'pr_proposed':
      return actor && {
        title: withApp(titleLabel ? t('push:prProposed.title.named', { actor, title: titleLabel }) : t('push:prProposed.title.plain', { actor })),
        body: t('push:prProposed.body', { actor }),
      };
    // #2273: these four kinds arrived with the per-app notification controls,
    // after the contextual push registry was written. They were push-eligible
    // but had no visible copy here, so every delivery collapsed to the generic
    // "You have new activity" fallback even though the worker had already
    // loaded the actor, app, proposal and detail needed to identify it.
    case 'proposal_vote': {
      if (!actor) return null;
      let title;
      if (detail === 'no') {
        title = titleLabel ? t('push:proposalVote.no.title.named', { actor, title: titleLabel }) : t('push:proposalVote.no.title.plain', { actor });
      } else {
        title = titleLabel ? t('push:proposalVote.yes.title.named', { actor, title: titleLabel }) : t('push:proposalVote.yes.title.plain', { actor });
      }
      // #1688: the voter's line IS the news. Quoted when they left one, so
      // the proposer reads what to fix from the banner itself.
      const voteReason = cleanText(context.voteReason);
      return {
        title: withApp(title),
        body: voteReason
          ? t('push:proposalVote.body.reason', { reason: truncate(voteReason, VOTE_REASON_EMBED_MAX) })
          : t('push:proposalVote.body.plain'),
      };
    }
    case 'pr_merged': {
      // #1688: `detail` names the people on a merge the vote carried
      // ("Backed by alice and bob, shaped by carol."); an admin override
      // keeps its marker and its own line.
      // #2897: a child app's merge rebuilds production before this row is
      // written, so "live" is true when it arrives. The platform's own merge
      // is released afterwards, outside this process (GitHub Actions, then
      // Argo CD; services/release-watch.js), so at merge time it is only on
      // its way. Say so rather than claim a deploy that has not happened.
      const soon = context.appSelfHosted === true;
      let body;
      if (detail === 'forced') {
        body = soon ? t('push:prMerged.body.forced.soon') : t('push:prMerged.body.forced.live');
      } else if (detail) {
        body = t('push:prMerged.body.credits', { credits: truncate(detail, 120) });
      } else {
        body = soon ? t('push:prMerged.body.carried.soon') : t('push:prMerged.body.carried.live');
      }
      return {
        // B10d: live, in the words every screen uses; the platform's own
        // change is approved now and live in a few minutes.
        title: withApp(soon
          ? (titleLabel ? t('push:prMerged.title.approved.named', { title: titleLabel }) : t('push:prMerged.title.approved.plain'))
          : (titleLabel ? t('push:prMerged.title.live.named', { title: titleLabel }) : t('push:prMerged.title.live.plain'))),
        body,
      };
    }
    // #1688: the author pushed a new version of a change this person had
    // backed. Their yes no longer counts until they look again; the row in
    // the app carries the one tap that keeps it. "One story": it says who
    // the update was for (`detail` is "epoch:<n>[:<asker>]", the asker
    // "@name" or "you", notifications.createRevisionRecheckNotifications),
    // never "after your feedback" when it was somebody else's.
    case 'revision_recheck': {
      const subject = changeTitle(label, app, t);
      const asked = /^epoch:\d+:(you|@[A-Za-z0-9_.-]{1,40})$/.exec(detail || '');
      const bot = context.sourceIsSynthetic === true;
      let body;
      if (asked?.[1] === 'you') {
        body = actor ? t('push:revisionRecheck.body.person.you', { actor }) : t('push:revisionRecheck.body.unnamed.you');
      } else if (asked) {
        const asker = asked[1].slice(1);
        body = actor ? t('push:revisionRecheck.body.person.asker', { actor, asker }) : t('push:revisionRecheck.body.unnamed.asker', { asker });
      } else if (bot) {
        body = actor ? t('push:revisionRecheck.body.person.bot', { actor }) : t('push:revisionRecheck.body.unnamed.bot');
      } else {
        body = actor ? t('push:revisionRecheck.body.person.plain', { actor }) : t('push:revisionRecheck.body.unnamed.plain');
      }
      return {
        title: subject ? t('push:revisionRecheck.title.named', { change: subject }) : t('push:revisionRecheck.title.plain'),
        body,
      };
    }
    // #4396: a project this person joined while it was made is open: its
    // first version went live (services/project-opened.js).
    case 'project_opened':
      return {
        title: app ? t('push:projectOpened.title.app', { app }) : t('push:projectOpened.title.plain'),
        body: t('push:projectOpened.body'),
      };
    // #4787: the change this person voted on went live. #2897's split, as
    // pr_merged above: a child app's merge is live when the row arrives; the
    // platform's own is released a few minutes after. `detail` is 'yes' when
    // their vote was yes (createVotedChangeMergedNotifications).
    case 'voted_change_merged': {
      const soon = context.appSelfHosted === true;
      const yes = detail === 'yes';
      let body;
      if (soon) body = yes ? t('push:votedChangeMerged.body.soon.yes') : t('push:votedChangeMerged.body.soon.voted');
      else body = yes ? t('push:votedChangeMerged.body.live.yes') : t('push:votedChangeMerged.body.live.voted');
      return {
        title: changeTitle(label, app, t) || (soon ? t('push:votedChangeMerged.title.soon') : t('push:votedChangeMerged.title.live')),
        body,
      };
    }
    // #1688: the Friday card. `detail` is "<merged>:<open>" — how many
    // changes went live this week and how many proposals are waiting.
    // #6371: the one person-wide row carries
    // `w:<projects>:<merged>:<open>` and says it is ready, under every
    // project; the per-project format keeps today's wording.
    case 'weekly_digest': {
      const week = /^w:(\d+):(\d+):(\d+)$/.exec(detail || '');
      if (week) {
        const merged = Number(week[2]);
        const open = Number(week[3]);
        const shipped = merged === 0
          ? t('push:weeklyDigest.body.nothing')
          : t('push:weeklyDigest.body.shipped', { count: merged });
        return {
          title: t('push:weeklyDigest.title.ready'),
          body: open === 0
            ? shipped
            : t('push:weeklyDigest.body.both', { shipped, waiting: t('push:weeklyDigest.body.waiting', { count: open }) }),
        };
      }
      const counts = /^(\d+):(\d+)$/.exec(detail || '');
      const merged = counts ? Number(counts[1]) : 0;
      const open = counts ? Number(counts[2]) : 0;
      const shipped = merged === 0
        ? t('push:weeklyDigest.body.nothing')
        : t('push:weeklyDigest.body.shipped', { count: merged });
      return {
        title: app ? t('push:weeklyDigest.title.app', { app }) : t('push:weeklyDigest.title.plain'),
        body: open === 0
          ? shipped
          : t('push:weeklyDigest.body.both', { shipped, waiting: t('push:weeklyDigest.body.waiting', { count: open }) }),
      };
    }
    case 'issue_opened': {
      const numbered = /^\d+$/.test(detail);
      let title;
      if (actor) {
        title = numbered ? t('push:issueOpened.title.person.numbered', { actor, number: detail }) : t('push:issueOpened.title.person.plain', { actor });
      } else {
        title = numbered ? t('push:issueOpened.title.unnamed.numbered', { number: detail }) : t('push:issueOpened.title.unnamed.plain');
      }
      return {
        title: withApp(title),
        body: t('push:issueOpened.body'),
      };
    }
    case 'vote_digest': {
      const count = /^\d+$/.test(detail) ? Math.max(0, Number(detail)) : 0;
      // Where a tap goes (notifications.js): one change opens that change,
      // several Needs you (#needs), which lists them.
      return {
        title: count ? t('push:voteDigest.title', { count }) : t('push:voteDigest.title.plain'),
        body: count === 1 ? t('push:voteDigest.body.one') : t('push:voteDigest.body.many'),
      };
    }
    case 'voted_digest': {
      // Names no project or change: a count, and Your votes has the rest.
      const count = /^\d+$/.test(detail) ? Math.max(0, Number(detail)) : 0;
      return {
        title: count ? t('push:votedDigest.title', { count }) : t('push:votedDigest.title.plain'),
        body: t('push:votedDigest.body'),
      };
    }
    case 'check_failed':
      return {
        title: withApp(titleLabel ? t('push:checkFailed.title.named', { title: titleLabel }) : t('push:checkFailed.title.plain')),
        body: t('push:checkFailed.body'),
      };
    case 'stale_pr': {
      // Its votes are met and its merge is what stands still: asking for
      // votes would send the author after the wrong thing.
      if (detail === 'blocked') {
        return {
          title: withApp(titleLabel ? t('push:stalePr.blocked.title.named', { title: titleLabel }) : t('push:stalePr.blocked.title.plain')),
          body: t('push:stalePr.blocked.body'),
        };
      }
      const days = daysSince(context.promotedAt, now);
      return {
        title: withApp(titleLabel
          ? t('push:stalePr.waiting.title.named', { title: titleLabel }) : t('push:stalePr.waiting.title.plain')),
        body: days >= 1
          ? t('push:stalePr.waiting.body.days', { count: days })
          : t('push:stalePr.waiting.body.plain'),
      };
    }
    // #1405 path A. The agent, not you, put this somewhere — so the copy leads
    // with the destination, which is the fact you cannot infer from being away.
    case 'connector_submitted':
      return {
        title: withApp(titleLabel
          ? t('push:connectorSubmitted.title.named', { title: titleLabel })
          : t('push:connectorSubmitted.title.plain')),
        body: context.detail === 'shared'
          ? t('push:connectorSubmitted.body.shared')
          : t('push:connectorSubmitted.body.waiting'),
      };
    // #1405 path B, and the copy is load-bearing.
    //
    // It says WHEN the question was asked, never "Claude is waiting on you".
    // The difference matters because the clear depends on the agent calling
    // back, which it may forget: "is waiting on you" is FALSE once you have
    // answered, and a notification making a false claim reads as broken. "asked
    // you something N minutes ago" stays true either way, which turns the
    // failure this design cannot prevent into a mild redundancy instead.
    case 'agent_awaiting_input': {
      const mins = minutesSince(context.armedAt || context.createdAt, now);
      return {
        title: withApp(t('push:agentAwaiting.title')),
        body: mins >= 1
          ? t('push:agentAwaiting.body.minutes', { count: mins })
          : t('push:agentAwaiting.body.plain'),
      };
    }
    // #2253: the app storage cap speaks through app_health, and its two
    // tokens say what happened and what to do. #2273 gives the existing
    // deploy-failure token its own copy too. The full failure reason stays on
    // the app row; the push identifies the event and points to that detail.
    case 'app_health': {
      // #6494: the early and warning notices carry the figures. A bare token
      // written before this change keeps the old copy.
      const storage = /^storage_(early|warn):(\d{1,9}):(\d{1,9})$/.exec(detail);
      if (storage) {
        const used = storageSizeText(Number(storage[2]));
        const limit = storageSizeText(Number(storage[3]));
        if (storage[1] === 'early') {
          return {
            title: withApp(t('push:appHealth.storageEarly.title')),
            body: app
              ? t('push:appHealth.storageEarly.body.app', { app, used, limit })
              : t('push:appHealth.storageEarly.body.plain', { used, limit }),
          };
        }
        return {
          title: withApp(t('push:appHealth.storageWarn.title')),
          body: app
            ? t('push:appHealth.storageWarn.bodySized.app', { app, used, limit })
            : t('push:appHealth.storageWarn.bodySized.plain', { used, limit }),
        };
      }
      if (detail === 'storage_warn') {
        return {
          title: withApp(t('push:appHealth.storageWarn.title')),
          body: app ? t('push:appHealth.storageWarn.body.app', { app }) : t('push:appHealth.storageWarn.body.plain'),
        };
      }
      if (detail === 'storage_full') {
        return {
          title: withApp(t('push:appHealth.storageFull.title')),
          body: t('push:appHealth.storageFull.body'),
        };
      }
      if (detail === 'deploy_failed') {
        return {
          title: withApp(t('push:appHealth.deployFailed.title')),
          body: t('push:appHealth.deployFailed.body'),
        };
      }
      // The platform's own app: merged, but the release outside the platform
      // (the image workflow, Argo CD, the rollout) has not delivered it.
      if (detail === 'release_stalled') {
        return {
          title: withApp(t('push:appHealth.releaseStalled.title')),
          body: t('push:appHealth.releaseStalled.body'),
        };
      }
      return {
        title: withApp(t('push:appHealth.other.title')),
        body: t('push:appHealth.other.body'),
      };
    }
    // A server-wide cap nearing or at its ceiling, for full admins only
    // (services/platform-limit-alerts.js). The detail token carries which
    // cap, the level and the figures, so the push can say how close it is.
    case 'platform_limit':
      return platformLimitCopy(detail);
    // #6643: a change held for an admin's approval, for full admins
    // (services/release-holds.js). The change's own name says which.
    case 'release_hold':
      // A detail that starts "notice:" is a change the rules could not read
      // in full: it is not held, and the push says so.
      if (/^notice:/.test(String(detail || ''))) {
        return {
          title: withApp(t('push:releaseHold.notice.title')),
          body: label ? t('push:releaseHold.notice.body.named', { title: label }) : t('push:releaseHold.notice.body.plain'),
        };
      }
      return {
        title: withApp(t('push:releaseHold.title')),
        body: label ? t('push:releaseHold.body.named', { title: label }) : t('push:releaseHold.body.plain'),
      };
    // #4296: errors that should not happen, a daily digest or one kind past
    // its hourly line (services/platform-incident-alerts.js). Full admins.
    case 'platform_incident':
      return platformIncidentCopy(detail);
    default:
      return null;
  }
}

function genericCopy(t) {
  try {
    return { title: GENERIC_COPY.title, body: cleanText(t('push:generic.body')) || GENERIC_COPY.body };
  } catch {
    return { ...GENERIC_COPY };
  }
}

function buildNotificationCopy(kind, context, now = new Date(), translate = null) {
  const t = translate || pushText.english;
  try {
    const copy = buildCopy(kind, context && typeof context === 'object' ? context : {}, now, t);
    const title = copy ? truncate(cleanText(copy.title), TITLE_MAX) : '';
    if (!title) return genericCopy(t);
    const body = truncate(cleanText(copy.body), BODY_MAX);
    return body ? { title, body } : { title };
  } catch {
    return genericCopy(t);
  }
}

function buildMessage({
  token, notificationId, kind, environment, installationId, userId,
  expiresAt, context, unreadCount, now = new Date(), translate = null,
}) {
  if (typeof token !== 'string' || !token) throw new Error('mobile_push_registration_missing');
  if (!ALLOWED_KINDS.has(kind) || isPushParked(kind)) throw new Error('mobile_push_kind_not_allowed');
  const id = Number(notificationId);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
    throw new Error('mobile_push_notification_id_invalid');
  }
  const remaining = new Date(expiresAt).getTime() - new Date(now).getTime();
  const ttl = Math.min(MAX_TTL_MS, remaining);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('mobile_push_delivery_expired');

  const collapseId = `usernode-social-${id}`;
  const message = {
    token,
    notification: buildNotificationCopy(kind, context, now, translate),
    data: {
      source: 'usernode_social',
      schema: '1',
      environment: String(environment),
      notification_id: String(id),
      recipient_binding: recipientBinding({ installationId, userId, environment }),
    },
    android: {
      ttl,
      collapseKey: collapseId,
      notification: { channelId: 'social_activity', tag: collapseId },
    },
    apns: {
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor((new Date(now).getTime() + ttl) / 1000)),
        'apns-collapse-id': collapseId,
      },
      payload: { aps: { category: 'USERNODE_SOCIAL', threadId: 'usernode-social' } },
    },
  };
  // #1445: the homescreen icon badge. iOS only ever badges the icon when a
  // push carries `aps.badge`; Android launchers read the count from
  // `notificationCount`. Like the copy context above, this is display-only
  // and optional — anything but a usable count degrades to omitting the
  // field (the pre-badge payload) rather than failing the delivery.
  if (Number.isSafeInteger(unreadCount) && unreadCount >= 0) {
    message.android.notification.notificationCount = unreadCount;
    message.apns.payload.aps.badge = unreadCount;
  }
  return message;
}

// #2904: a badge-only APNs push. iOS keeps the icon at whatever the LAST
// push's `aps.badge` said until something sets it again, and the app is
// the only other thing that can — so notifications read on another device
// (or while the WebView was suspended) left the icon on a stale count with
// nothing in-app to explain it. This carries the fresh total and nothing
// else: no `notification` block, no `data`, so iOS updates the icon without
// presenting a banner and the native shell has no social payload to route.
// `alert` is still the right push type — Apple files badge changes under it
// — and priority 5 keeps it off the immediate-delivery budget.
const BADGE_TTL_MS = 60 * 60 * 1000;

function buildBadgeMessage({ token, unreadCount, now = new Date() }) {
  if (typeof token !== 'string' || !token) throw new Error('mobile_push_registration_missing');
  if (!Number.isSafeInteger(unreadCount) || unreadCount < 0) {
    throw new Error('mobile_push_badge_count_invalid');
  }
  return {
    token,
    apns: {
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': '5',
        'apns-expiration': String(Math.floor((new Date(now).getTime() + BADGE_TTL_MS) / 1000)),
      },
      payload: { aps: { badge: unreadCount } },
    },
  };
}

module.exports = {
  ALLOWED_KINDS,
  PARKED_PUSH_KINDS,
  isPushParked,
  botMomentCopy,
  buildNotificationCopy,
  plainMarkdown,
  MAX_TTL_MS,
  RECIPIENT_CONTEXT,
  PUSH_ENV_RE,
  isPushEnvironment,
  recipientBinding,
  buildMessage,
  buildBadgeMessage,
  BADGE_TTL_MS,
};
