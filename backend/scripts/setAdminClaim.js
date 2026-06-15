import "dotenv/config";
import admin from "firebase-admin";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "recipeai-frontend";

function parseArgs(argv) {
  const args = {
    uid: null,
    email: null,
    role: "owner",
    remove: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--uid") {
      const value = String(argv[index + 1] || "").trim();
      if (value) {
        args.uid = value;
        index += 1;
      }
    } else if (arg.startsWith("--uid=")) {
      const value = String(arg.slice("--uid=".length)).trim();
      if (value) args.uid = value;
    } else if (arg === "--email") {
      const value = String(argv[index + 1] || "").trim();
      if (value) {
        args.email = value;
        index += 1;
      }
    } else if (arg.startsWith("--email=")) {
      const value = String(arg.slice("--email=".length)).trim();
      if (value) args.email = value;
    } else if (arg === "--role") {
      const value = String(argv[index + 1] || "").trim();
      if (value) {
        args.role = value;
        index += 1;
      }
    } else if (arg.startsWith("--role=")) {
      const value = String(arg.slice("--role=".length)).trim();
      if (value) args.role = value;
    } else if (arg === "--remove") {
      args.remove = true;
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

async function resolveUser({ uid, email }) {
  if (uid) return admin.auth().getUser(uid);
  if (email) return admin.auth().getUserByEmail(email);
  throw new Error("Pass --uid USER_UID or --email user@example.com");
}

function buildNextClaims(existingClaims = {}, { role, remove }) {
  const nextClaims = { ...(existingClaims || {}) };

  if (remove) {
    delete nextClaims.admin;
    delete nextClaims.owner;
    delete nextClaims.role;
    if (Array.isArray(nextClaims.roles)) {
      nextClaims.roles = nextClaims.roles.filter((value) => value !== "admin" && value !== "owner");
      if (nextClaims.roles.length === 0) delete nextClaims.roles;
    }
    return nextClaims;
  }

  const normalizedRole = role === "admin" ? "admin" : "owner";
  nextClaims.admin = true;
  nextClaims.role = normalizedRole;
  if (normalizedRole === "owner") nextClaims.owner = true;

  const roles = Array.isArray(nextClaims.roles) ? nextClaims.roles : [];
  nextClaims.roles = Array.from(new Set([...roles, normalizedRole, "admin"]));

  return nextClaims;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  initializeAdmin();

  const user = await resolveUser(args);
  const existingClaims = user.customClaims || {};
  const nextClaims = buildNextClaims(existingClaims, args);

  await admin.auth().setCustomUserClaims(user.uid, nextClaims);

  console.log("[setAdminClaim] updated custom claims", {
    projectId: PROJECT_ID,
    uid: user.uid,
    email: user.email || null,
    remove: args.remove,
    before: existingClaims,
    after: nextClaims,
  });

  console.log("[setAdminClaim] user must sign out/in or refresh ID token before claims are visible to /admin endpoints");
}

main().catch((err) => {
  console.error("[setAdminClaim] failed", err?.message || err);
  process.exit(1);
});
