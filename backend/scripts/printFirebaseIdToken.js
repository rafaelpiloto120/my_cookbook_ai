import "dotenv/config";
import fetch from "node-fetch";
import readline from "readline";

const DEFAULT_FIREBASE_WEB_API_KEY = "AIzaSyDuPZ3__DSl0K1XPU6XivUHqVt1A5e-zr4";

function parseArgs(argv) {
  const args = {
    email: null,
    verifyAdminUrl: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--email") {
      const value = String(argv[index + 1] || "").trim();
      if (value) {
        args.email = value;
        index += 1;
      }
    } else if (arg.startsWith("--email=")) {
      const value = String(arg.slice("--email=".length)).trim();
      if (value) args.email = value;
    } else if (arg === "--verify-admin-url") {
      const value = String(argv[index + 1] || "").trim();
      if (value) {
        args.verifyAdminUrl = value;
        index += 1;
      }
    } else if (arg.startsWith("--verify-admin-url=")) {
      const value = String(arg.slice("--verify-admin-url=".length)).trim();
      if (value) args.verifyAdminUrl = value;
    }
  }

  return args;
}

function readSecretFromStdin(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

async function signInWithPassword({ email, password, apiKey }) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Firebase sign-in failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  if (!data.idToken) {
    throw new Error("Firebase sign-in succeeded but did not return an ID token");
  }

  return data;
}

async function verifyAdminEndpoint({ url, token }) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep text body.
  }
  return {
    status: response.status,
    ok: response.ok,
    body,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email || process.env.FIREBASE_AUTH_EMAIL;
  const apiKey = process.env.FIREBASE_WEB_API_KEY || DEFAULT_FIREBASE_WEB_API_KEY;
  const password =
    process.env.FIREBASE_AUTH_PASSWORD ||
    (await readSecretFromStdin("Firebase password: "));

  if (!email) {
    throw new Error("Pass --email user@example.com or set FIREBASE_AUTH_EMAIL");
  }
  if (!password) {
    throw new Error("Password is required");
  }

  const result = await signInWithPassword({ email, password, apiKey });

  console.log("[printFirebaseIdToken] signed in", {
    email,
    localId: result.localId || null,
    expiresIn: result.expiresIn || null,
  });

  console.log(result.idToken);

  if (args.verifyAdminUrl) {
    const adminResult = await verifyAdminEndpoint({
      url: args.verifyAdminUrl,
      token: result.idToken,
    });
    console.log("[printFirebaseIdToken] admin endpoint result", adminResult);
  }
}

main().catch((err) => {
  console.error("[printFirebaseIdToken] failed", err?.message || err);
  process.exit(1);
});
