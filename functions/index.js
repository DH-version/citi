const admin = require("firebase-admin");
const functionsV1 = require("firebase-functions/v1");
const {setGlobalOptions} = require("firebase-functions/v2");
const {onDocumentCreated, onDocumentUpdated} = require("firebase-functions/v2/firestore");

admin.initializeApp();
setGlobalOptions({region: "us-central1"});

const GEELONG_SUBURBS = [
  "north geelong", "south geelong", "geelong west", "geelong east", "east geelong",
  "st albans park", "bell post hill", "hamlyn heights", "manifold heights", "ocean grove",
  "barwon heads", "point lonsdale", "clifton springs", "indented head",
  "waurn ponds", "armstrong creek", "bells beach", "aireys inlet", "st leonards",
  "little river", "mount duneed", "wandana heights", "lovely banks", "jan juc",
  "geelong", "newtown", "belmont", "highton", "grovedale", "marshall",
  "lara", "corio", "norlane", "leopold", "drysdale", "portarlington",
  "curlewis", "queenscliff", "torquay", "anglesea", "fairhaven",
  "charlemont", "fyansford", "breakwater", "whittington", "moolap",
  "herne hill", "rippleside", "drumcondra", "thomson", "ceres", "bannockburn", "inverleigh"
].map(function(s) { return s.trim().toLowerCase(); }).sort(function(a, b) {
  return b.length - a.length;
});

let cachedTokenEntries = null;
let cachedTokenTime = 0;
const TOKEN_CACHE_MS = 15000;

function titleCaseWords(text) {
  return String(text || "").split(" ").filter(Boolean).map(function(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");
}

function extractSuburb(address) {
  const raw = String(address || "").trim().toLowerCase();
  if (!raw) return "";
  let i;
  for (i = 0; i < GEELONG_SUBURBS.length; i++) {
    if (raw.includes(GEELONG_SUBURBS[i])) {
      return titleCaseWords(GEELONG_SUBURBS[i]);
    }
  }
  const parts = raw.split(",");
  for (i = parts.length - 1; i >= 0; i--) {
    const part = parts[i].replace(/\b(vic|victoria)\b/gi, "").replace(/\b\d{4}\b/g, "").trim();
    if (!part) continue;
    for (let j = 0; j < GEELONG_SUBURBS.length; j++) {
      if (part.includes(GEELONG_SUBURBS[j])) {
        return titleCaseWords(GEELONG_SUBURBS[j]);
      }
    }
  }
  return "";
}

function formatJobTime(job) {
  if (job.timeInput) {
    let time = String(job.timeInput);
    if (job.ampm && job.ampm !== "None") time += " " + job.ampm;
    return time.toUpperCase();
  }
  if (job.time && job.time !== "Future" && job.time !== "Later") {
    return String(job.time).toUpperCase();
  }
  if (job.time === "Future" || job.time === "Later") return "FUTURE";
  return "ASAP";
}

function newJobPushText(job) {
  const jobNum = "JOB-" + (job.id || "?");
  const pickupSub = extractSuburb(job.pickup);
  const dropSub = extractSuburb(job.drop);
  const title = "NEW JOB · " + jobNum;
  if (!pickupSub && !dropSub) {
    return { title: title, body: "New job notification — tap to view" };
  }
  const route = (pickupSub || "Pickup") + " → " + (dropSub || "Drop-off");
  const name = String(job.name || "").trim();
  let body = route.toUpperCase() + " · " + formatJobTime(job);
  if (name) body = titleCaseWords(name) + " · " + body;
  return { title: title, body: body };
}

async function loadTokenEntries() {
  const now = Date.now();
  if (cachedTokenEntries && now - cachedTokenTime < TOKEN_CACHE_MS) {
    return cachedTokenEntries;
  }
  const snap = await admin.firestore().collection("pushTokens").get();
  const entries = [];
  snap.forEach(function(doc) {
    const data = doc.data() || {};
    if (!data.token) return;
    entries.push({
      token: data.token,
      operator: String(data.operator || "").trim().toLowerCase(),
      sessionId: String(data.sessionId || "")
    });
  });
  cachedTokenEntries = entries;
  cachedTokenTime = now;
  return entries;
}

async function collectTokens(excludeOperators, excludeSessionIds) {
  excludeOperators = excludeOperators || [];
  excludeSessionIds = excludeSessionIds || [];
  const exclude = new Set(
    excludeOperators.map(function(name) {
      return String(name || "").trim().toLowerCase();
    }).filter(Boolean)
  );
  const excludeSessions = new Set(
    excludeSessionIds.map(function(id) { return String(id || ""); }).filter(Boolean)
  );
  const entries = await loadTokenEntries();
  const tokens = [];
  entries.forEach(function(entry) {
    if (exclude.has(entry.operator)) return;
    if (excludeSessions.has(entry.sessionId)) return;
    tokens.push(entry.token);
  });
  return Array.from(new Set(tokens));
}

function removeBadTokens(tokens, responses) {
  const batch = admin.firestore().batch();
  let deletes = 0;
  const lookups = responses.map(function(result, index) {
    if (result.success) return Promise.resolve(null);
    const code = result.error && result.error.code;
    if (code !== "messaging/registration-token-not-registered" && code !== "messaging/invalid-registration-token") {
      return Promise.resolve(null);
    }
    const badToken = tokens[index];
    if (!badToken) return Promise.resolve(null);
    return admin.firestore().collection("pushTokens").where("token", "==", badToken).get();
  });
  return Promise.all(lookups).then(function(snaps) {
    snaps.forEach(function(snap) {
      if (!snap) return;
      snap.forEach(function(doc) {
        batch.delete(doc.ref);
        deletes++;
      });
    });
    if (deletes) {
      cachedTokenEntries = null;
      return batch.commit();
    }
    return null;
  });
}

function buildPushLink(safeData) {
  const base = "https://dh-version.github.io/citi/index.html";
  const pushType = safeData.type || "";
  const docId = safeData.docId || "";
  if (pushType === "team_chat") {
    return base + "?tab=team&type=team_chat";
  }
  if (docId) {
    let link = base + "?job=" + encodeURIComponent(docId);
    if (pushType) link += "&type=" + encodeURIComponent(pushType);
    return link;
  }
  return base;
}

async function sendPush(tokens, notification, data) {
  if (!tokens.length) return null;
  const icon = "https://dh-version.github.io/citi/icons/icon-192.png";
  const safeData = Object.keys(data || {}).reduce(function(acc, key) {
    acc[key] = String(data[key]);
    return acc;
  }, {});
  const docId = safeData.docId || "";
  const pushType = safeData.type || "";
  const link = buildPushLink(safeData);
  const tag = pushType === "team_chat" ? ("chat-" + (safeData.chatId || "team")) : (docId || pushType || "gpn-push");
  const payload = {
    tokens: tokens,
    notification: notification,
    data: safeData,
    webpush: {
      headers: { Urgency: "high", TTL: "86400" },
      notification: {
        title: notification.title,
        body: notification.body,
        icon: icon,
        badge: icon,
        requireInteraction: true,
        tag: tag
      },
      fcmOptions: { link: link }
    },
    android: {
      priority: "high",
      notification: { priority: "high" }
    }
  };
  const result = await admin.messaging().sendEachForMulticast(payload);
  removeBadTokens(tokens, result.responses).catch(function(err) {
    console.error("removeBadTokens failed", err);
  });
  return result;
}

exports.onJobCreated = onDocumentCreated({
  document: "jobs/{jobId}"
}, async function(event) {
  const job = event.data.data() || {};
  if (job.status && job.status !== "available") return null;

  cachedTokenEntries = null;
  const exclude = job.operator ? [job.operator] : [];
  const tokens = await collectTokens(exclude);
  const pushText = newJobPushText(job);
  return sendPush(tokens, {
    title: pushText.title,
    body: pushText.body
  }, {
    type: "new_job",
    docId: event.params.jobId,
    jobId: String(job.id || ""),
    skipOperator: job.operator || ""
  });
});

exports.onJobUpdated = onDocumentUpdated({
  document: "jobs/{jobId}"
}, async function(event) {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};

  if (before.status === "available" && after.status === "accepted" && after.acceptedBy) {
    cachedTokenEntries = null;
    const tokens = await collectTokens([after.acceptedBy]);
    return sendPush(tokens, {
      title: "JOB ACCEPTED · JOB-" + (after.id || "?"),
      body: "Accepted by " + after.acceptedBy
    }, {
      type: "job_accepted",
      docId: event.params.jobId,
      jobId: String(after.id || "")
    });
  }

  if (before.status === "accepted" && after.status === "available" && !after.acceptedBy) {
    cachedTokenEntries = null;
    const recaller = before.acceptedBy || after.recalledBy || "";
    const excludeSessions = after.recalledBySession ? [after.recalledBySession] : [];
    const tokens = await collectTokens(recaller ? [recaller] : [], excludeSessions);
    const pickupSub = extractSuburb(after.pickup);
    const dropSub = extractSuburb(after.drop);
    let body = "Available again — tap to view";
    if (pickupSub || dropSub) {
      body = (pickupSub || "Pickup") + " → " + (dropSub || "Drop-off");
      body = body.toUpperCase();
    }
    return sendPush(tokens, {
      title: "JOB RECALLED · JOB-" + (after.id || "?"),
      body: body
    }, {
      type: "job_recalled",
      docId: event.params.jobId,
      jobId: String(after.id || ""),
      recalledBy: recaller,
      excludeSessionId: after.recalledBySession || ""
    });
  }

  return null;
});

// Team chat push — v1 so it deploys without migrating existing v1 job functions.
exports.onNoticeCreated = functionsV1
  .region("us-central1")
  .firestore.document("noticeBoard/{msgId}")
  .onCreate(async function(snap, context) {
    const msg = snap.data() || {};
    const sender = msg.operator || "";
    cachedTokenEntries = null;
    const excludeSessions = msg.sessionId ? [msg.sessionId] : [];
    const tokens = await collectTokens(sender ? [sender] : [], excludeSessions);
    const preview = String(msg.message || "").trim();
    const body = preview.length > 140 ? preview.slice(0, 137) + "…" : preview;
    return sendPush(tokens, {
      title: "💬 " + (sender || "Team Chat"),
      body: body || "New team message"
    }, {
      type: "team_chat",
      chatId: context.params.msgId,
      senderOperator: sender,
      excludeSessionId: msg.sessionId || ""
    });
  });
