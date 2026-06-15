import "dotenv/config";
import admin from "firebase-admin";
import { Firestore } from "@google-cloud/firestore";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "recipeai-frontend";
const FIRESTORE_DB_ID = process.env.FIREBASE_DATABASE_ID || "(default)";
const USER_SUMMARIES_COLLECTION =
  process.env.FIREBASE_USER_SUMMARIES_COLLECTION || "userSummaries";
const PAGE_SIZE = 1000;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: null,
    uid: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--limit") {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) {
        args.limit = Math.floor(value);
        index += 1;
      }
    } else if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (Number.isFinite(value) && value > 0) args.limit = Math.floor(value);
    } else if (arg === "--uid") {
      const value = String(argv[index + 1] || "").trim();
      if (value) {
        args.uid = value;
        index += 1;
      }
    } else if (arg.startsWith("--uid=")) {
      const value = String(arg.slice("--uid=".length)).trim();
      if (value) args.uid = value;
    }
  }

  return args;
}

function initializeAdmin() {
  if (admin.apps.length) return;

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: PROJECT_ID,
    });
    return;
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: PROJECT_ID,
  });
}

function getDb() {
  const options = { projectId: PROJECT_ID };
  if (FIRESTORE_DB_ID && FIRESTORE_DB_ID !== "(default)") {
    options.databaseId = FIRESTORE_DB_ID;
  }
  return new Firestore(options);
}

function millisFromAuthDate(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function millisFromValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value && typeof value.toMillis === "function") {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

function maxTimestamp(...values) {
  const timestamps = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return timestamps.length ? Math.max(...timestamps) : null;
}

function userSummaryFromAuth(user) {
  const providerIds = Array.isArray(user.providerData)
    ? user.providerData.map((provider) => provider.providerId).filter(Boolean)
    : [];
  const isAnonymous =
    providerIds.length === 0 &&
    !user.email &&
    !user.phoneNumber &&
    !user.displayName;
  const createdAt = millisFromAuthDate(user.metadata?.creationTime);
  const lastSeenAt = millisFromAuthDate(user.metadata?.lastSignInTime);

  return {
    uid: user.uid,
    email: user.email || null,
    displayName: user.displayName || null,
    phoneNumber: user.phoneNumber || null,
    isAnonymous,
    providerIds,
    createdAt,
    firstSeenAt: createdAt,
    lastSeenAt,
  };
}

function getLatestDocTimestamp(snapshot) {
  let latest = null;
  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    latest = maxTimestamp(
      latest,
      millisFromValue(data.updatedAt),
      millisFromValue(data.createdAt),
      millisFromValue(data.date),
      millisFromValue(data.loggedAt)
    );
  });
  return latest;
}

async function countCollection(collectionRef) {
  const snap = await collectionRef.get();
  return {
    count: snap.size,
    latestAt: getLatestDocTimestamp(snap),
  };
}

async function buildSummaryForUser(db, user) {
  const base = userSummaryFromAuth(user);
  const uid = user.uid;

  const [economySnap, recipes, myDayMeals, myDayWeights] = await Promise.all([
    db.doc(`users/${uid}/economy/default`).get(),
    countCollection(db.collection(`users/${uid}/recipes`)),
    countCollection(db.collection(`users/${uid}/myDayMeals`)),
    countCollection(db.collection(`users/${uid}/myDayWeights`)),
  ]);

  const economy = economySnap.exists ? economySnap.data() || {} : {};
  const cookies =
    typeof economy.cookies === "number" && Number.isFinite(economy.cookies)
      ? economy.cookies
      : null;
  const freePremiumActionsRemaining =
    typeof economy.freePremiumActionsRemaining === "number" &&
    Number.isFinite(economy.freePremiumActionsRemaining)
      ? Math.max(0, Math.floor(economy.freePremiumActionsRemaining))
      : null;
  const economyUpdatedAt = maxTimestamp(
    millisFromValue(economy.updatedAt),
    millisFromValue(economy.createdAt)
  );
  const lastRealActionAt = maxTimestamp(
    recipes.latestAt,
    myDayMeals.latestAt,
    myDayWeights.latestAt
  );

  return {
    ...base,
    recipeCount: recipes.count,
    mealCount: myDayMeals.count,
    weightLogCount: myDayWeights.count,
    cookies,
    freePremiumActionsRemaining,
    economyUpdatedAt,
    lastRealActionAt,
    lastSeenAt: maxTimestamp(base.lastSeenAt, lastRealActionAt, economyUpdatedAt),
    backfilledAt: Date.now(),
    _serverBackfilledAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function listTargetUsers(uid) {
  if (uid) {
    return [await admin.auth().getUser(uid)];
  }

  const users = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(PAGE_SIZE, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  initializeAdmin();
  const db = getDb();
  const users = await listTargetUsers(args.uid);
  const limitedUsers = args.limit ? users.slice(0, args.limit) : users;

  console.log("[backfillUserSummaries] starting", {
    projectId: PROJECT_ID,
    databaseId: FIRESTORE_DB_ID,
    collection: USER_SUMMARIES_COLLECTION,
    totalAuthUsers: users.length,
    selectedUsers: limitedUsers.length,
    dryRun: args.dryRun,
    uid: args.uid,
  });

  let processed = 0;
  let written = 0;
  let failed = 0;

  for (const user of limitedUsers) {
    try {
      const summary = await buildSummaryForUser(db, user);
      processed += 1;

      if (args.dryRun) {
        console.log("[backfillUserSummaries] dry-run summary", {
          uid: summary.uid,
          email: summary.email,
          isAnonymous: summary.isAnonymous,
          recipeCount: summary.recipeCount,
          mealCount: summary.mealCount,
          weightLogCount: summary.weightLogCount,
          cookies: summary.cookies,
          freePremiumActionsRemaining: summary.freePremiumActionsRemaining,
          lastRealActionAt: summary.lastRealActionAt,
        });
      } else {
        await db.collection(USER_SUMMARIES_COLLECTION).doc(user.uid).set(summary, { merge: true });
        written += 1;
      }

      if (processed % 100 === 0) {
        console.log("[backfillUserSummaries] progress", { processed, written, failed });
      }
    } catch (err) {
      failed += 1;
      console.error("[backfillUserSummaries] failed user", {
        uid: user.uid,
        message: err?.message || String(err),
      });
    }
  }

  console.log("[backfillUserSummaries] complete", {
    processed,
    written,
    failed,
    dryRun: args.dryRun,
  });

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[backfillUserSummaries] fatal", err?.message || err);
  process.exit(1);
});
