// --- Helper: wrap a promise with a timeout (default 10s) ---
function withTimeout(promise, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("⏱ Request timed out")), ms)
    ),
  ]);
}
// --- Helper: recursively enforce language on all string fields in object/array ---
async function enforceLanguageOnObject(obj, targetLang) {
  if (typeof obj === "string") {
    return await ensureLanguage(obj, targetLang);
  }
  if (Array.isArray(obj)) {
    return await Promise.all(obj.map(item => enforceLanguageOnObject(item, targetLang)));
  }
  if (obj && typeof obj === "object") {
    const out = {};
    for (const key of Object.keys(obj)) {
      out[key] = await enforceLanguageOnObject(obj[key], targetLang);
    }
    return out;
  }
  return obj;
}
import 'dotenv/config';
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";
import PDFDocument from "pdfkit";
import scrapeRecipe from "recipe-scraper";
import multer from "multer";
import Tesseract from "tesseract.js";
import { franc } from "franc";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import path from "path";
import he from "he";
import fs from "fs";

import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();

app.use(cors());
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("MyCookbook AI backend is running ✅");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---------------- Simple in-memory AI rate limiting ----------------
const AI_LIMITS = {
  PER_USER_HOURLY: 50, // 50 AI generations per hour per user/device
  PER_USER_DAILY: 100, // 100 per day per user/device
  PER_IP_DAILY: 100,   // 100 per day per IP
};

// Maps: key -> { count, windowStartMs }
const aiUserHourly = new Map(); // key = userId || deviceId
const aiUserDaily = new Map();  // key = userId || deviceId
const aiIpDaily = new Map();    // key = ip string

function getClientIdentifiers(req) {
  const headers = req.headers || {};
  const deviceIdHeader =
    headers["x-device-id"] ||
    headers["X-Device-Id"] ||
    headers["x-deviceid"] ||
    null;
  const userIdHeader =
    (req.user && req.user.uid) ||
    headers["x-user-id"] ||
    headers["X-User-Id"] ||
    headers["x-userid"] ||
    null;

  const deviceId = deviceIdHeader ? String(deviceIdHeader) : null;
  const userId = userIdHeader ? String(userIdHeader) : null;

  // Prefer userId, fall back to deviceId as the logical "user key"
  const userKey = userId || deviceId || null;

  // IP detection – if behind proxy, prefer x-forwarded-for
  const ipHeader = headers["x-forwarded-for"];
  const ip = Array.isArray(ipHeader)
    ? ipHeader[0]
    : (ipHeader ? ipHeader.split(",")[0].trim() : req.ip);

  return { userId, deviceId, userKey, ip };
}

function checkAndIncrementLimit(map, key, windowMs, maxCount) {
  const now = Date.now();
  const entry = map.get(key);

  if (!entry || now - entry.windowStartMs > windowMs) {
    // New window
    map.set(key, { count: 1, windowStartMs: now });
    return { ok: true, remaining: maxCount - 1 };
  }

  if (entry.count >= maxCount) {
    return { ok: false, remaining: 0 };
  }

  entry.count += 1;
  return { ok: true, remaining: maxCount - entry.count };
}

/**
 * Enforce:
 * - 50 AI generations / hour per user/device
 * - 100 AI generations / day per user/device
 * - 100 AI generations / day per IP
 */
function enforceAiRateLimit(req) {
  const { userKey, ip } = getClientIdentifiers(req);
  const reasons = [];

  // Only enforce user limits if we have a userKey (userId or deviceId)
  if (userKey) {
    const hourly = checkAndIncrementLimit(
      aiUserHourly,
      userKey,
      60 * 60 * 1000, // 1 hour
      AI_LIMITS.PER_USER_HOURLY
    );
    if (!hourly.ok) {
      reasons.push("user_hourly");
    }

    const daily = checkAndIncrementLimit(
      aiUserDaily,
      userKey,
      24 * 60 * 60 * 1000, // 24 hours
      AI_LIMITS.PER_USER_DAILY
    );
    if (!daily.ok) {
      reasons.push("user_daily");
    }
  }

  // IP-based limit
  if (ip) {
    const ipDaily = checkAndIncrementLimit(
      aiIpDaily,
      ip,
      24 * 60 * 60 * 1000, // 24 hours
      AI_LIMITS.PER_IP_DAILY
    );
    if (!ipDaily.ok) {
      reasons.push("ip_daily");
    }
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      reasons,
    };
  }

  return { ok: true, reasons: [] };
}

// ---------------- Simple file-based analytics logger ----------------
const ANALYTICS_LOG_PATH =
  process.env.ANALYTICS_LOG_PATH ||
  path.resolve(__dirname, "analytics-events.log");

/**
 * Extract best-effort context from request (for analytics).
 * Later you can start sending x-device-id and x-user-id from the app
 * without breaking anything.
 */
function getEventContext(req) {
  const headers = req.headers || {};
  const deviceId =
    headers["x-device-id"] ||
    headers["X-Device-Id"] ||
    headers["x-deviceid"] ||
    null;
  const userIdHeader =
    headers["x-user-id"] ||
    headers["X-User-Id"] ||
    headers["x-userid"] ||
    null;

  return {
    deviceId: deviceId ? String(deviceId) : null,
    userId: userIdHeader ? String(userIdHeader) : null,
  };
}


/**
 * Track analytics events.
 * In production, events can be stored in Firestore by setting ANALYTICS_USE_FIRESTORE=1.
 * Otherwise (or if Firestore is unavailable), they are appended to a local log file.
 *
 * Example event shape:
 * { "ts": "...", "eventType": "ai_recipe_generated", "userId": "...", "deviceId": "...", "metadata": {...} }
 */
function trackEvent(
  eventType,
  { userId = null, deviceId = null, metadata = null } = {}
) {
  try {
    const payload = {
      ts: new Date().toISOString(),
      eventType,
      userId,
      deviceId,
      metadata,
    };

    const useFirestore =
      process.env.ANALYTICS_USE_FIRESTORE === "1" ||
      process.env.ANALYTICS_USE_FIRESTORE === "true";

    // Prefer Firestore when explicitly enabled and Firebase Admin is initialized
    if (
      useFirestore &&
      _adminInitialized &&
      admin &&
      Array.isArray(admin.apps) &&
      admin.apps.length > 0
    ) {
      try {
        const db = getFirestore(undefined, FIRESTORE_DB_ID);
        db.collection(ANALYTICS_COLLECTION)
          .add(payload)
          .catch((err) => {
            console.error(
              "❌ Failed to write analytics event to Firestore:",
              err?.message || err
            );
          });
      } catch (err) {
        console.error(
          "❌ Analytics Firestore error, falling back to file:",
          err?.message || err
        );
        const line = JSON.stringify(payload) + "\n";
        fs.appendFile(ANALYTICS_LOG_PATH, line, (fileErr) => {
          if (fileErr) {
            console.error(
              "❌ Failed to write analytics event to file:",
              fileErr.message || fileErr
            );
          }
        });
      }
    } else {
      // Default: local file-based logging (useful for local dev)
      const line = JSON.stringify(payload) + "\n";
      fs.appendFile(ANALYTICS_LOG_PATH, line, (err) => {
        if (err) {
          console.error(
            "❌ Failed to write analytics event to file:",
            err.message || err
          );
        }
      });
    }
  } catch (err) {
    console.error("❌ Analytics error:", err.message || err);
  }
}

// ---------------- Analytics Event Endpoint ----------------
// Accepts: { eventType, metadata, userId, deviceId }
app.post("/analytics-event", async (req, res) => {
  try {
    const body = req.body || {};
    const eventType = typeof body.eventType === "string" ? body.eventType.trim() : "";
    if (!eventType) {
      return res.status(400).json({ error: "eventType is required" });
    }
    // Get fallback context from headers
    const headerCtx = getEventContext(req);
    // Prefer explicit userId/deviceId from body if provided
    const finalUserId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : headerCtx.userId;
    const finalDeviceId = typeof body.deviceId === "string" && body.deviceId.trim() ? body.deviceId.trim() : headerCtx.deviceId;
    const metadata = body.metadata !== undefined ? body.metadata : null;
    trackEvent(eventType, {
      userId: finalUserId,
      deviceId: finalDeviceId,
      metadata: metadata || null,
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /analytics-event error:", err?.message || err);
    return res.status(500).json({ error: "Failed to log analytics event" });
  }
});

// Serve frontend assets (for default_recipe.png, etc)
app.use("/assets", express.static(path.resolve(__dirname, "../frontend/RecipeAI/assets")));

const upload = multer({ storage: multer.memoryStorage() });

// ---- Image validation and rate limiting helpers ----
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function validateUploadedImage(file) {
  if (!file) {
    const err = new Error("No file uploaded");
    err.statusCode = 400;
    throw err;
  }

  const mimetype = file.mimetype || file.type || "";
  const size = typeof file.size === "number" ? file.size : 0;

  if (!ALLOWED_IMAGE_TYPES.has(mimetype)) {
    const err = new Error("Unsupported image type");
    err.statusCode = 400;
    throw err;
  }

  if (size <= 0 || size > MAX_IMAGE_BYTES) {
    const err = new Error("Image too large (max 3 MB)");
    err.statusCode = 400;
    throw err;
  }
}

const uploadRateMap = new Map();
const MAX_UPLOADS_PER_HOUR = 50; // adjust if needed
const UPLOAD_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkUploadRateLimit(key) {
  const now = Date.now();
  const entry = uploadRateMap.get(key);

  if (!entry) {
    uploadRateMap.set(key, { count: 1, windowStart: now });
    return;
  }

  const { count, windowStart } = entry;

  if (now - windowStart > UPLOAD_WINDOW_MS) {
    uploadRateMap.set(key, { count: 1, windowStart: now });
    return;
  }

  if (count >= MAX_UPLOADS_PER_HOUR) {
    const err = new Error("Upload rate limit exceeded");
    err.statusCode = 429;
    throw err;
  }

  entry.count += 1;
}

// ---------------- Firebase Admin (Storage via backend) ----------------
// Initialize Admin SDK using either a JSON service account in env or Application Default Credentials.
// Expected envs (optional):
// - FIREBASE_SERVICE_ACCOUNT  (JSON string)
// - FIREBASE_STORAGE_BUCKET   (e.g. "recipeai-frontend.appspot.com")
// - FIREBASE_PROJECT_ID       (e.g. "recipeai-frontend")
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "recipeai-frontend";
const BUCKET_NAME = process.env.FIREBASE_STORAGE_BUCKET || `${PROJECT_ID}.appspot.com`;
const ANALYTICS_COLLECTION =
  process.env.FIREBASE_ANALYTICS_COLLECTION || "analyticsEvents";
const FIRESTORE_DB_ID =
  process.env.FIREBASE_DATABASE_ID || "(default)";

let _adminInitialized = false;
if (!admin.apps.length) {
  try {
    const svc = process.env.FIREBASE_SERVICE_ACCOUNT
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      : null;

    if (svc) {
      admin.initializeApp({
        credential: admin.credential.cert(svc),
        storageBucket: BUCKET_NAME,
        projectId: PROJECT_ID,
      });
    } else {
      // Fallback to ADC (e.g., GOOGLE_APPLICATION_CREDENTIALS)
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        storageBucket: BUCKET_NAME,
        projectId: PROJECT_ID,
      });
    }
    _adminInitialized = true;
    console.log("✅ Firebase Admin initialized (Storage)");
    console.log("   Using project:", PROJECT_ID);
    console.log("   Using bucket :", BUCKET_NAME);
    console.log("   Firestore DB :", FIRESTORE_DB_ID);
  } catch (e) {
    console.error("❌ Failed to initialize Firebase Admin:", e?.message || e);
  }
}

// Helper: verify Firebase ID token from Authorization header
async function verifyIdTokenFromHeader(req) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) throw new Error("Missing Bearer token");
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded; // { uid, ... }
  } catch (err) {
    throw new Error("Invalid Firebase ID token");
  }
}
// ---- Helper: Delete all possible recipe images for a recipe from Firebase Storage ----
async function deleteRecipeImages(uid, recipeId) {
  if (!_adminInitialized) return;
  const bucket = admin.storage().bucket(BUCKET_NAME);
  const exts = ["jpg", "jpeg", "png", "webp"]; // try common extensions
  for (const ext of exts) {
    const path = `users/${uid}/recipes/${recipeId}/image.${ext}`;
    const file = bucket.file(path);
    try {
      await file.delete({ ignoreNotFound: true });
    } catch (err) {
      if (err && err.code !== 404) {
        console.warn("[deleteRecipeImages] failed", path, err.message || err);
      }
    }
  }
}

// ---- DEBUG ENDPOINTS (temporary; remove for production) ----
app.get("/debug/storage", async (req, res) => {
  try {
    const opts = admin.app().options || {};
    const configuredProject = opts.projectId || process.env.FIREBASE_PROJECT_ID || null;
    const configuredBucket = BUCKET_NAME;

    let exists = false;
    let existsError = null;
    try {
      const [ex] = await admin.storage().bucket(configuredBucket).exists();
      exists = !!ex;
    } catch (e) {
      existsError = e && (e.message || String(e));
    }

    res.json({
      configuredProject,
      configuredBucket,
      bucketExists: exists,
      bucketExistsError: existsError,
    });
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || String(err) });
  }
});

app.get("/debug/creds", async (req, res) => {
  try {
    let saProjectId = null;
    let saClientEmail = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        saProjectId = svc.project_id || null;
        saClientEmail = svc.client_email || null;
      } catch { }
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      try {
        const fs = await import("fs");
        const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (p && fs.default.existsSync(p)) {
          const raw = fs.default.readFileSync(p, "utf8");
          const json = JSON.parse(raw);
          saProjectId = json.project_id || null;
          saClientEmail = json.client_email || null;
        }
      } catch { }
    }

    res.json({
      saProjectId,
      saClientEmail,
      configuredProject: process.env.FIREBASE_PROJECT_ID || null,
      configuredBucket: BUCKET_NAME,
    });
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || String(err) });
  }
});

// ---------------- Upload Profile Photo (multipart -> Storage via Admin) ----------------
// Client sends: Authorization: Bearer <ID_TOKEN>
// Form field: file (binary), optional fields: uid, path
app.post("/uploadProfilePhoto", upload.single("file"), async (req, res) => {
  try {
    if (!_adminInitialized) {
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    // Auth
    let decoded;
    try {
      decoded = await verifyIdTokenFromHeader(req);
    } catch (e) {
      return res.status(401).json({ error: e.message || "Unauthorized" });
    }

    // Rate limiting
    const rateKey = (decoded && decoded.uid) || req.ip || "anon";
    try {
      checkUploadRateLimit(rateKey);
    } catch (err) {
      return res.status(err.statusCode || 429).json({ error: err.message || "Rate limit exceeded" });
    }

    // File
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No file uploaded (field 'file')" });
    }

    // Enforce type and size limits
    try {
      validateUploadedImage(req.file);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message || "Invalid image" });
    }

    const uid = (req.body && req.body.uid) ? String(req.body.uid) : decoded.uid;
    // Default target path (client may override via body.path)
    let targetPath = (req.body && req.body.path) ? String(req.body.path) : `users/${uid}/profile/avatar.jpg`;

    // Content-Type
    const contentType = req.file.mimetype || "image/jpeg";

    // Write to Storage
    const bucket = admin.storage().bucket(BUCKET_NAME);
    console.log("[/uploadProfilePhoto] Writing to bucket:", BUCKET_NAME, "path:", targetPath, "contentType:", contentType);
    const file = bucket.file(targetPath);
    await file.save(req.file.buffer, {
      contentType,
      resumable: false,
      metadata: { cacheControl: "public, max-age=3600" },
    });

    // Public read URL via a long-lived signed URL
    const [signedUrl] = await file.getSignedUrl({ action: "read", expires: "2099-12-31" });

    // Analytics: profile photo uploaded
    const ctx = getEventContext(req);
    trackEvent("profile_photo_uploaded", {
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      metadata: {
        path: targetPath,
        contentType,
      },
    });

    return res.json({ url: signedUrl });
  } catch (err) {
    console.error("/uploadProfilePhoto error:", err);
    const msg = err?.message || "Upload failed";
    return res.status(500).json({ error: msg });
  }
});

// ---------------- Upload Recipe Image (multipart -> Storage via Admin) ----------------
// Client sends: Authorization: Bearer <ID_TOKEN>
// Form fields:
//   - file (binary, required)
//   - path (string, optional) e.g. users/{uid}/recipes/{recipeId}/image.jpg
//   - contentType (string, optional) e.g. image/jpeg
app.post("/uploadRecipeImage", upload.single("file"), async (req, res) => {
  try {
    if (!_adminInitialized) {
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    // Auth
    let decoded;
    try {
      decoded = await verifyIdTokenFromHeader(req);
    } catch (e) {
      return res.status(401).json({ error: e.message || "Unauthorized" });
    }

    // Rate limiting
    const rateKey = (decoded && decoded.uid) || req.ip || "anon";
    try {
      checkUploadRateLimit(rateKey);
    } catch (err) {
      return res.status(err.statusCode || 429).json({ error: err.message || "Rate limit exceeded" });
    }

    // File validation
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No file uploaded (field 'file')" });
    }

    // Enforce type and size limits
    try {
      validateUploadedImage(req.file);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message || "Invalid image" });
    }

    const uid = (req.body && req.body.uid) ? String(req.body.uid) : decoded.uid;
    // Default path if not provided by client
    let targetPath =
      (req.body && req.body.path)
        ? String(req.body.path)
        : `users/${uid}/recipes/${Date.now()}/image.jpg`;

    // Normalize/guard the path to stay under the user's namespace
    if (!targetPath.startsWith(`users/${uid}/`)) {
      targetPath = `users/${uid}/recipes/${Date.now()}/image.jpg`;
    }

    const contentType =
      (req.body && req.body.contentType) ||
      req.file.mimetype ||
      "image/jpeg";

    const bucket = admin.storage().bucket(BUCKET_NAME);
    console.log("[/uploadRecipeImage] Writing to bucket:", BUCKET_NAME, "path:", targetPath, "contentType:", contentType);
    const file = bucket.file(targetPath);

    await file.save(req.file.buffer, {
      contentType,
      resumable: false,
      metadata: { cacheControl: "public, max-age=3600" },
    });

    // Generate a long-lived signed URL (download URL)
    const [signedUrl] = await file.getSignedUrl({
      action: "read",
      expires: "2099-12-31",
    });

    // Analytics: recipe image uploaded
    const ctx = getEventContext(req);
    trackEvent("recipe_image_uploaded", {
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      metadata: {
        path: targetPath,
        contentType,
      },
    });

    return res.json({ url: signedUrl, path: targetPath });
  } catch (err) {
    console.error("/uploadRecipeImage error:", err);
    const msg = err?.message || "Upload failed";
    return res.status(500).json({ error: msg });
  }
});
// ---- Find and patch the recipe delete route to remove associated images ----
// Example: (your actual route may differ, adapt as needed)
// app.delete("/recipes/:id", async (req, res) => {
//   // ... auth and param extraction ...
//   try {
//     await db.deleteRecipe(uid, recipeId);
//     await deleteRecipeImages(uid, recipeId);
//     res.json({ ok: true });
//   } catch (err) {
//     // ...
//   }
// });

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/** ---------------------------
 * Helpers / Normalizers
 * --------------------------*/

// --- Helper: sanitize inputs ---
function sanitizeInput(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/[^a-zA-Z0-9 ,.;:!?áéíóúàèìòùçãõâêîôûÁÉÍÓÚÀÈÌÒÙÇÃÕÂÊÎÔÛ-]/g, "")
    .trim()
    .slice(0, 200);
}

// --- Helper: ensure text is in correct language using franc ---
async function ensureLanguage(text, targetLang) {
  if (!text || typeof text !== "string") return text;
  // Do not translate fixed enum labels used by the app
  const _enumLock = ["Easy", "Moderate", "Challenging", "Cheap", "Medium", "Expensive"];
  if (_enumLock.includes(text.trim())) {
    return text.trim();
  }
  try {
    // Force translation for very short texts
    if (text.length <= 30) {
      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `You are a translator. Translate the following text into ${targetLang}.` },
          { role: "user", content: text }
        ],
        temperature: 0.3,
      });
      return completion.choices[0].message.content.trim();
    }

    const detected = franc(text);
    const map = { por: "Portuguese", spa: "Spanish", fra: "French", deu: "German", ita: "Italian", eng: "English" };
    const detectedLang = map[detected] || "English";
    if (detectedLang.toLowerCase() !== targetLang.toLowerCase()) {
      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `You are a translator. Translate the following text into ${targetLang}.` },
          { role: "user", content: text }
        ],
        temperature: 0.3,
      });
      return completion.choices[0].message.content.trim();
    }
  } catch (err) {
    console.warn("Language check failed:", err.message);
  }
  return text;
}

// --- Helper: clean JSON output from OpenAI (strip markdown fences) ---
function cleanJsonResponse(text) {
  if (!text) return "";
  return text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

// --- Helper: safe JSON parse with fallback ---
function safeJSONParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn("⚠️ JSON parse failed, attempting recovery:", e.message);
    try {
      // First try cleaned response
      const cleaned = cleanJsonResponse(raw);
      console.log("🔎 Raw response:", raw);
      console.log("🧹 Cleaned response:", cleaned);
      return JSON.parse(cleaned);
    } catch (e2) {
      try {
        const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (match) return JSON.parse(match[0]);
      } catch (e3) {
        console.error("❌ Recovery parse failed:", e3.message);
      }
    }
    return fallback;
  }
}

// --- Helper: normalize language to canonical form ---
function normalizeLanguage(lang) {
  if (!lang || typeof lang !== "string") return "English";
  const lower = lang.toLowerCase();

  if (lower.includes("pt-br") || lower.includes("portuguese (br")) {
    return "Portuguese (Brazil)";
  }
  if (lower.includes("pt") || lower.includes("portuguese (pt")) {
    return "Portuguese (Portugal)";
  }
  if (lower.includes("spanish") || lower.includes("es") || lower.includes("esp")) return "Spanish";
  if (lower.includes("french") || lower.includes("fr") || lower.includes("fra")) return "French";
  if (lower.includes("german") || lower.includes("de") || lower.includes("ger")) return "German";
  if (lower.includes("italian") || lower.includes("it") || lower.includes("ita")) return "Italian";
  return "English";
}

// --- Helper: normalize measurement system to canonical form ---
function normalizeMeasurementSystem(system) {
  if (!system || typeof system !== "string") return "Metric";
  const lower = system.toLowerCase();

  if (lower.includes("us") || lower.includes("imperial")) {
    return "US";
  }
  if (lower.includes("metric")) {
    return "Metric";
  }
  if (lower.includes("uk") || lower.includes("british")) {
    // We currently treat UK as using metric in the app UI
    return "Metric";
  }
  return "Metric";
}

// --- Helper: round numbers to a given number of decimals ---
function roundTo(value, decimals = 1) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// --- Helper: convert basic metric units in a text line to US units ---
// This is a safety net in case the model mixes systems when the user selected "US".
// It handles simple patterns like "600g", "0.5 kg", "250 ml", "1.5 l", etc.
function convertMetricToUSInText(text) {
  if (typeof text !== "string") return text;

  let out = text;

  // kg -> lb
  out = out.replace(/(\d+(?:[.,]\d+)?)\s*(kg|kilograms?)/gi, (match, num) => {
    const kg = parseFloat(String(num).replace(",", "."));
    if (!isFinite(kg) || kg <= 0) return match;
    const lb = kg * 2.20462;
    const rounded = roundTo(lb, lb >= 10 ? 0 : 1);
    return `${rounded} lb${rounded !== 1 ? "s" : ""}`;
  });

  // g -> oz (or lb for very large values)
  out = out.replace(/(\d+(?:[.,]\d+)?)\s*(g|grams?)/gi, (match, num) => {
    const g = parseFloat(String(num).replace(",", "."));
    if (!isFinite(g) || g <= 0) return match;

    // If it's around or above 1 lb, express as pounds
    if (g >= 453.592) {
      const lb = g / 453.592;
      const rounded = roundTo(lb, lb >= 10 ? 0 : 1);
      return `${rounded} lb${rounded !== 1 ? "s" : ""}`;
    } else {
      const oz = g / 28.3495;
      const rounded = roundTo(oz, oz >= 10 ? 0 : 1);
      return `${rounded} oz`;
    }
  });

  // ml -> cups or fl oz
  out = out.replace(/(\d+(?:[.,]\d+)?)\s*(ml|millilit(?:er|re)s?)/gi, (match, num) => {
    const ml = parseFloat(String(num).replace(",", "."));
    if (!isFinite(ml) || ml <= 0) return match;

    // For larger volumes, use cups (approx. 240 ml per cup)
    if (ml >= 240) {
      const cups = ml / 240;
      const rounded = roundTo(cups, cups >= 10 ? 0 : 1);
      return `${rounded} cup${rounded !== 1 ? "s" : ""}`;
    } else {
      // Smaller volumes as fluid ounces (approx. 29.57 ml per fl oz)
      const floz = ml / 29.5735;
      const rounded = roundTo(floz, floz >= 10 ? 0 : 1);
      return `${rounded} fl oz`;
    }
  });

  // l -> cups (approx. 240 ml per cup)
  out = out.replace(/(\d+(?:[.,]\d+)?)\s*(l|liters?|litres?)/gi, (match, num) => {
    const l = parseFloat(String(num).replace(",", "."));
    if (!isFinite(l) || l <= 0) return match;
    const cups = (l * 1000) / 240;
    const rounded = roundTo(cups, cups >= 10 ? 0 : 1);
    return `${rounded} cup${rounded !== 1 ? "s" : ""}`;
  });

  return out;
}

// Extract JSON-LD recipe objects from HTML
function extractJsonLd(html) {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]');
  let recipes = [];
  scripts.each((_, el) => {
    try {
      const json = JSON.parse($(el).contents().text());
      if (Array.isArray(json)) {
        json.forEach(j => {
          if (j["@type"] && (
            (typeof j["@type"] === "string" && j["@type"].toLowerCase().includes("recipe")) ||
            (Array.isArray(j["@type"]) && j["@type"].some(t => typeof t === "string" && t.toLowerCase().includes("recipe")))
          )) {
            recipes.push(j);
          }
        });
      } else if (json && typeof json === "object") {
        // Handle @graph property
        if (Array.isArray(json["@graph"])) {
          json["@graph"].forEach(entry => {
            if (entry["@type"] && (
              (typeof entry["@type"] === "string" && entry["@type"].toLowerCase().includes("recipe")) ||
              (Array.isArray(entry["@type"]) && entry["@type"].some(t => typeof t === "string" && t.toLowerCase().includes("recipe")))
            )) {
              recipes.push(entry);
            }
          });
        }
        // Top-level object is recipe
        else if (json["@type"] && (
          (typeof json["@type"] === "string" && json["@type"].toLowerCase().includes("recipe")) ||
          (Array.isArray(json["@type"]) && json["@type"].some(t => typeof t === "string" && t.toLowerCase().includes("recipe")))
        )) {
          recipes.push(json);
        }
      }
    } catch (e) {
      // ignore invalid JSON
    }
  });
  return recipes;
}

// Normalize tags and include mealType as a tag (except “I’m just hungry”)
function normalizeTags(tags, mealType) {
  let out = [];
  if (Array.isArray(tags)) {
    out = tags
      .map((t) =>
        t
          .toString()
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9\s]/gi, "")
      )
      .filter(Boolean)
      .map((t) => t.charAt(0).toUpperCase() + t.slice(1));
  }

  if (mealType && mealType !== "I’m just hungry") {
    if (!out.includes(mealType)) {
      out.push(mealType);
    }
  }

  return out.slice(0, 5);
}

// Auto-number steps and strip prior numbering
function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return ["No steps provided"];
  return steps
    .filter((s) => typeof s === "string" && s.trim())
    .map((s, i) => {
      const clean = s.trim().replace(/^(step\s*)?\d+[\).:-]?\s*/i, "");
      return `${i + 1}. ${clean}`;
    });
}

// --- Helper: normalize difficulty values from multiple languages to English enums ---
function normalizeDifficulty(raw) {
  if (!raw) return "Easy";

  // Convert to lowercase, strip accents, and keep only letters
  let clean = raw
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "");

  // Easy keywords
  const easyWords = ["easy", "facil", "faci", "simple", "simplic", "leicht", "facio", "facile"];
  if (easyWords.some(w => clean.includes(w))) {
    return "Easy";
  }

  // Moderate keywords
  const moderateWords = ["medium", "moderate", "medio", "moyen", "mittel", "intermediate", "intermedio"];
  if (moderateWords.some(w => clean.includes(w))) {
    return "Moderate";
  }

  // Challenging keywords
  const hardWords = ["hard", "challeng", "dificil", "difficile", "schwer", "fort", "complic", "dura", "duras"];
  if (hardWords.some(w => clean.includes(w))) {
    return "Challenging";
  }

  // Fallback
  return "Easy";

  // Debug log
  console.log("🔍 Difficulty normalization:", { raw, clean, normalized });
}

// Sanitize a full recipe object and align difficulty to: Easy | Moderate | Challenging
function validateRecipe(raw, mealType) {
  const difficulty = normalizeDifficulty(raw.difficulty);

  // ---- Robust normalization for ingredients ----
  let normalizedIngredients = [];
  if (Array.isArray(raw.ingredients)) {
    normalizedIngredients = raw.ingredients
      .flatMap((item) => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (item && typeof item === "object") {
          // Common patterns from some models: { text: "..."} or { name: "..." }
          if (typeof item.text === "string") {
            return item.text.trim();
          }
          if (typeof item.name === "string") {
            return item.name.trim();
          }
        }
        return [];
      })
      .filter(Boolean);
  }
  if (!normalizedIngredients.length) {
    normalizedIngredients = ["No ingredients provided"];
  }

  // ---- Robust normalization for steps ----
  let rawStepsArray = [];
  if (Array.isArray(raw.steps)) {
    rawStepsArray = raw.steps
      .flatMap((item) => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (item && typeof item === "object") {
          // Common patterns from some models: { text: "..."} or { step: "..."}
          if (typeof item.text === "string") {
            return item.text.trim();
          }
          if (typeof item.step === "string") {
            return item.step.trim();
          }
          if (typeof item.description === "string") {
            return item.description.trim();
          }
        }
        return [];
      })
      .filter(Boolean);
  }
  if (!rawStepsArray.length) {
    rawStepsArray = ["No steps provided"];
  }
  const normalizedSteps = normalizeSteps(rawStepsArray);

  const safe = {
    id:
      typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : `${Date.now()}`,
    title:
      typeof raw.title === "string" && raw.title.trim()
        ? raw.title.trim()
        : "Untitled Recipe",
    cookingTime:
      typeof raw.cookingTime === "number" &&
        raw.cookingTime > 0 &&
        raw.cookingTime <= 180
        ? raw.cookingTime
        : 30,
    difficulty,
    servings:
      typeof raw.servings === "number" &&
        raw.servings > 0 &&
        raw.servings <= 999
        ? raw.servings
        : 2,
    cost: ["Cheap", "Medium", "Expensive"].includes(raw.cost)
      ? raw.cost
      : "Medium",
    ingredients: normalizedIngredients,
    steps: normalizedSteps,
    tags: normalizeTags(raw.tags, mealType),
    createdAt: new Date().toISOString(),
  };

  // Attach a default image if not provided
  const query = encodeURIComponent(
    safe.title.split(" ").slice(0, 2).join(" ") || "food"
  );
  safe.image =
    (raw && typeof raw.image === "string" && raw.image.trim()) ||
    `https://source.unsplash.com/600x400/?${query},food`;

  return safe;
}

/** ---------------------------
 * API Endpoints
 * --------------------------*/

// Suggestions (3 cards for the wizard review)
app.post("/getRecipeSuggestions", async (req, res) => {
  let { note, people, time, dietary, avoid, mealType, avoidOther, language } = req.body;

  // Rate limiting: per-user/device/IP caps for AI suggestions
  const rateCheck = enforceAiRateLimit(req);
  if (!rateCheck.ok) {
    return res.status(429).json({
      error: "rate_limited",
      reasons: rateCheck.reasons,
      message:
        "You have reached the limit of AI recipe suggestions for now. Please try again later.",
    });
  }
  // Sanitize all relevant inputs
  note = sanitizeInput(note);
  time = sanitizeInput(time);
  mealType = sanitizeInput(mealType);
  // dietary and avoid may be arrays; sanitize each string
  if (Array.isArray(dietary)) dietary = dietary.map(sanitizeInput).filter(Boolean);
  else dietary = [];
  if (Array.isArray(avoid)) avoid = avoid.map(sanitizeInput).filter(Boolean);
  else avoid = [];
  // If avoid contains "other", merge avoidOther (split by commas, sanitize)
  if (avoid.includes("other") && typeof avoidOther === "string") {
    const otherArr = avoidOther
      .split(",")
      .map(sanitizeInput)
      .filter(Boolean);
    avoid = avoid.filter((a) => a !== "other").concat(otherArr);
  }
  language = normalizeLanguage(language);
  // Normalize measurement system from body (supports several possible field names)
  const measurementSystemNormalized = normalizeMeasurementSystem(
    (req.body && (req.body.measurementSystem || req.body.units || req.body.unitSystem)) || "Metric"
  );

  const mealPart =
    mealType && mealType !== "Im just hungry" && mealType !== "I’m just hungry"
      ? `- Meal type: ${mealType}\n`
      : "";

  // Improved userPrompt with explicit JSON block and language requirement, and explicit translation enforcement
  const userPrompt = `
I want you to provide 3 unique recipe suggestions based on the following constraints:

- User request/goal: ${note || "No specific request"}
- People to serve: ${people}
- Preferred cooking time: ${time}
- Dietary restrictions: ${dietary.length > 0 ? dietary.join(", ") : "None"}
- Ingredients to avoid: ${avoid.length > 0 ? avoid.join(", ") : "None"}
- Measurement system: ${measurementSystemNormalized}
${mealPart}

Return ONLY valid JSON of exactly 3 objects, written in ${language}, each matching this schema:
[
  {
    "id": "string",
    "title": "string",
    "cookingTime": number,        // minutes (5–180)
    "difficulty": "Easy" | "Moderate" | "Challenging",
    "description": "string"
  },
  ...
]

IMPORTANT: All text in every field must be written entirely in the target language (${language}). If any part of the output is not in ${language}, you must internally re-translate it before returning. Never return text in any other language.
`;

  try {
    const completion = await withTimeout(
      client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              `You are a professional chef assistant. Always reply ONLY with valid JSON that matches the schema provided and return exactly 3 recipe suggestions. All text must be written in the user’s selected language (${language}). No matter the input, always reply in ${language}. IMPORTANT: Every string field must be in ${language}. If any part of your output is not in ${language}, you must internally re-translate it before returning. Never return text in any other language. If the selected language is Portuguese (Portugal), always use European Portuguese (Portugal) and never Brazilian Portuguese. When you mention any quantities or units in descriptions, respect the user's measurement system: if it is "Metric", use metric units (g, kg, ml, l, etc.); if it is "US", use US/imperial units (cups, tbsp, tsp, oz, lb, etc.) and never mix systems.`,
          },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
      }),
      10000
    );

    let raw = completion.choices[0].message.content.trim();
    raw = cleanJsonResponse(raw);
    if (process.env.NODE_ENV !== "production") {
      console.log("🧹 Cleaned response (suggestions):", raw);
    }
    let suggestions = safeJSONParse(raw, []);
    // If not array or not 3, pad as before
    if (!Array.isArray(suggestions) || suggestions.length !== 3) {
      console.error("⚠️ Invalid JSON from AI for suggestions or incorrect count, padding with placeholders.");
      suggestions = [];
    }
    // Pad suggestions if less than 3
    while (suggestions.length < 3) {
      suggestions.push({
        id: `${Date.now()}_pad_${suggestions.length}`,
        title: "Placeholder Recipe",
        cookingTime: 30,
        difficulty: "Easy",
        description: "No description available.",
      });
    }
    // Batch enforce language on titles and descriptions, but NOT difficulty
    const titles = suggestions.map(s => s.title || "");
    const descriptions = suggestions.map(s => s.description || "");
    const ids = suggestions.map(s => s.id || "");
    // Batch translate titles, descriptions, ids
    const [translatedTitles, translatedDescriptions, translatedIds] = await Promise.all([
      ensureLanguage(titles, language),
      ensureLanguage(descriptions, language),
      ensureLanguage(ids, language),
    ]);
    suggestions = suggestions.map((s, idx) => ({
      ...s,
      id: translatedIds[idx] || s.id,
      title: translatedTitles[idx] || s.title,
      description: translatedDescriptions[idx] || s.description,
      difficulty: normalizeDifficulty(s.difficulty),
    }));

    // Analytics: AI suggestions generated
    const ctx = getEventContext(req);
    trackEvent("ai_suggestions_generated", {
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      metadata: {
        count: suggestions.length,
        language,
        measurementSystem: measurementSystemNormalized,
        mealType,
        hasNote: !!note,
        hasDietary: Array.isArray(dietary) && dietary.length > 0,
      },
    });

    res.json({ suggestions });
  } catch (error) {
    console.error("❌ Backend error (getRecipeSuggestions):", error);
    res.status(500).json({ error: "Failed to generate recipe suggestions" });
  }
});

// Full recipe (when user taps a suggestion card)
app.post("/getRecipe", async (req, res) => {
  let { note, people, time, dietary, avoid, mealType, suggestionId, suggestion, avoidOther, language } = req.body;

  // Rate limiting: per-user/device/IP caps for full AI recipes
  const rateCheck = enforceAiRateLimit(req);
  if (!rateCheck.ok) {
    return res.status(429).json({
      error: "rate_limited",
      reasons: rateCheck.reasons,
      message:
        "You have reached the limit of AI recipe generations for now. Please try again later.",
    });
  }
  // Sanitize all relevant inputs
  note = sanitizeInput(note);
  time = sanitizeInput(time);
  mealType = sanitizeInput(mealType);
  if (Array.isArray(dietary)) dietary = dietary.map(sanitizeInput).filter(Boolean);
  else dietary = [];
  if (Array.isArray(avoid)) avoid = avoid.map(sanitizeInput).filter(Boolean);
  else avoid = [];
  // If avoid contains "other", merge avoidOther (split by commas, sanitize)
  if (avoid.includes("other") && typeof avoidOther === "string") {
    const otherArr = avoidOther
      .split(",")
      .map(sanitizeInput)
      .filter(Boolean);
    avoid = avoid.filter((a) => a !== "other").concat(otherArr);
  }
  language = normalizeLanguage(language);
  // Normalize measurement system from body (supports several possible field names)
  const measurementSystemNormalized = normalizeMeasurementSystem(
    (req.body && (req.body.measurementSystem || req.body.units || req.body.unitSystem)) || "Metric"
  );

  const mealPart =
    mealType && mealType !== "Im just hungry" && mealType !== "I’m just hungry"
      ? `- Meal type: ${mealType}\n`
      : "";

  // If a suggestion was chosen, bias the model
  const suggestionContext = suggestion
    ? `\nThe user selected this suggestion as a base:\n${JSON.stringify(suggestion, null, 2)}\n`
    : "";

  // Improved userPrompt with explicit JSON schema block and language requirement, and explicit translation enforcement
  const userPrompt = `
I want you to generate a single detailed recipe based on the following constraints:

- User request/goal: ${note || "No specific request"}
- People to serve: ${people}
- Preferred cooking time: ${time}
- Dietary restrictions: ${dietary.length > 0 ? dietary.join(", ") : "None"}
- Ingredients to avoid: ${avoid.length > 0 ? avoid.join(", ") : "None"}
- Measurement system: ${measurementSystemNormalized}
${mealPart}
${suggestionContext}

Return ONLY valid JSON in ${language} (translate all strings, including ingredients, steps, and tags) matching exactly this schema:
{
  "title": "string",
  "cookingTime": number,  // minutes (5–180 realistic range)
  "difficulty": "Easy" | "Moderate" | "Challenging",
  "servings": number,     // 1–999
  "cost": "Cheap" | "Medium" | "Expensive",
  "ingredients": ["list of ingredients with quantities, always using the user's measurement system (${measurementSystemNormalized})"],
  "steps": ["step-by-step preparation instructions"],
  "tags": ["short tags like Vegan, Vegetarian, Gluten-Free, Dinner, Breakfast"]
}

For the ingredients and any quantities mentioned in the steps, you MUST strictly use the user's measurement system:
- If the measurement system is "Metric", use metric units such as g, kg, ml, l, etc., and avoid cups/ounces.
- If the measurement system is "US", use US/imperial units such as cups, tablespoons, teaspoons, ounces (oz), pounds (lb), etc., and avoid grams/milliliters.
Never mix measurement systems in the same recipe.

IMPORTANT: All text in every field must be written entirely in the target language (${language}). If any part of the output is not in ${language}, you must internally re-translate it before returning. Never return text in any other language.
`;

  try {
    const completion = await withTimeout(
      client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              `You are a professional chef assistant. Always reply ONLY with valid JSON that matches the schema provided. All text must be written in the user’s selected language (${language}), including ingredients, steps, and tags. No matter the input, always reply in ${language}. IMPORTANT: Every string field must be in ${language}. If any part of your output is not in ${language}, you must internally re-translate it before returning. Never return text in any other language. If the selected language is Portuguese (Portugal), always use European Portuguese (Portugal) and never Brazilian Portuguese. You must strictly respect the user's measurement system: for "Metric" use metric units (g, kg, ml, l, etc.), and for "US" use US/imperial units (cups, tbsp, tsp, oz, lb, etc.). Never mix measurement systems within a single recipe.`,
          },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
      }),
      25000
    );

    let raw = completion.choices[0].message.content.trim();
    raw = cleanJsonResponse(raw);
    if (process.env.NODE_ENV !== "production") {
      console.log("🧹 Cleaned response (recipe):", raw);
    }
    // Use safeJSONParse helper, then validate with mealType for tag normalization
    const parsed = safeJSONParse(raw, {});
    const safe = validateRecipe(parsed, mealType);
    // Normalize difficulty after validation (ensure always English enum)
    safe.difficulty = normalizeDifficulty(safe.difficulty);


    // --- Enforce language on title, ingredients, and steps (but not enums) ---
    if (safe) {
      const titleArr = [safe.title || ""];
      const ingredientsArr = Array.isArray(safe.ingredients) ? safe.ingredients : [];
      const stepsArr = Array.isArray(safe.steps) ? safe.steps : [];

      const [translatedTitleArr, translatedIngredients, translatedSteps] = await Promise.all([
        enforceLanguageOnObject(titleArr, language),
        enforceLanguageOnObject(ingredientsArr, language),
        enforceLanguageOnObject(stepsArr, language),
      ]);

      safe.title = translatedTitleArr[0] || safe.title;
      safe.ingredients = translatedIngredients;
      safe.steps = translatedSteps;
      // Do NOT translate difficulty or cost (keep as enums)
    }

    // --- Enforce measurement system on ingredient quantities (server-side safety net, AFTER translation) ---
    if (measurementSystemNormalized === "US") {
      if (Array.isArray(safe.ingredients)) {
        safe.ingredients = safe.ingredients.map((line) =>
          typeof line === "string" ? convertMetricToUSInText(line) : line
        );
      }
      if (Array.isArray(safe.steps)) {
        safe.steps = safe.steps.map((line) =>
          typeof line === "string" ? convertMetricToUSInText(line) : line
        );
      }
    }

    // --- Build tags according to AI Kitchen rules ---
    // Preserve original AI-suggested tags to use as a fallback source
    const aiBaseTags = Array.isArray(safe.tags) ? safe.tags : [];

    // 1) First tag: "AI Generated" (localized)
    const normalizedLang = normalizeLanguage(language);
    const aiGeneratedLabelMap = {
      "English": "AI Generated",
      "Portuguese (Portugal)": "Gerado por IA",
      "Portuguese (Brazil)": "Gerado por IA",
      "Spanish": "Generado por IA",
      "French": "G\u00e9n\u00e9r\u00e9 par IA",
      "German": "KI-generiert",
      "Italian": "Generato da IA",
    };
    const aiGeneratedLabel = aiGeneratedLabelMap[normalizedLang] || "AI Generated";

    let tags = [];
    tags.push(aiGeneratedLabel);

    // 2) Second tag: meal type from the first AI Kitchen question
    if (
      typeof mealType === "string" &&
      mealType.trim() &&
      mealType !== "Im just hungry" &&
      mealType !== "I\u2019m just hungry"
    ) {
      const mt = mealType.trim();
      if (!tags.some(t => t.toLowerCase() === mt.toLowerCase())) {
        tags.push(mt);
      }
    }

    // 3) Next tags: dietary restrictions (up to 3, without exceeding 5 total)
    if (Array.isArray(dietary)) {
      for (const d of dietary) {
        if (tags.length >= 5) break;
        const label = (d || "").toString().trim();
        if (!label) continue;
        if (!tags.some(t => t.toLowerCase() === label.toLowerCase())) {
          tags.push(label);
        }
      }
    }

    // 4) Fill remaining slots up to 5 using AI-suggested tags,
    //    as single words, in the selected language, skipping "avoid" items.
    const forbiddenTagSet = new Set(
      (Array.isArray(avoid) ? avoid : [])
        .map(a => (a || "").toString().trim().toLowerCase())
        .filter(Boolean)
    );

    for (const rawTag of aiBaseTags) {
      if (tags.length >= 5) break;
      if (typeof rawTag !== "string") continue;

      let candidate = rawTag.trim();
      if (!candidate) continue;

      // Remove punctuation but keep letters (including accents) and digits
      candidate = candidate.replace(/[^A-Za-z\u00c0-\u017f0-9\s]/g, "");
      const firstWord = candidate.split(/\s+/)[0];
      if (!firstWord) continue;

      const lower = firstWord.toLowerCase();
      if (forbiddenTagSet.has(lower)) continue;
      if (tags.some(t => t.toLowerCase() === lower)) continue;

      tags.push(firstWord);
    }

    // 5) Final cleanup and language enforcement for tags
    let finalTags = Array.from(
      new Set(
        tags
          .map(t => (typeof t === "string" ? t.trim() : ""))
          .filter(Boolean)
      )
    ).slice(0, 5);

    // Ensure tags are in the target language as well
    finalTags = await enforceLanguageOnObject(finalTags, language);
    if (!Array.isArray(finalTags) || !finalTags.length) {
      finalTags = tags.slice(0, 5);
    }
    safe.tags = finalTags;

    // Analytics: full AI recipe generated
    const ctx = getEventContext(req);
    trackEvent("ai_recipe_generated", {
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      metadata: {
        language,
        measurementSystem: measurementSystemNormalized,
        mealType,
        servings: safe.servings,
        cookingTime: safe.cookingTime,
        difficulty: safe.difficulty,
        cost: safe.cost,
        tags: safe.tags,
      },
    });

    res.json({ recipe: safe });
  } catch (error) {
    console.error("❌ Backend error (getRecipe):", error);
    res.status(500).json({ error: "Failed to generate recipe" });
  }
});

// Export recipe as PDF
app.post("/exportRecipePdf", (req, res) => {
  const { recipe } = req.body;
  if (!recipe) {
    return res.status(400).json({ error: "Recipe is required" });
  }

  try {
    const doc = new PDFDocument();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="recipe.pdf"');
    doc.pipe(res);

    doc.fontSize(20).text(recipe.title || "Untitled Recipe", { underline: true });
    doc.moveDown();

    doc.fontSize(12).text(`Cooking Time: ${recipe.cookingTime || "N/A"} minutes`);
    doc.text(`Servings: ${recipe.servings || "N/A"}`);
    doc.text(`Difficulty: ${recipe.difficulty || "N/A"}`);
    doc.text(`Cost: ${recipe.cost || "N/A"}`);
    doc.moveDown();

    doc.fontSize(16).text("Ingredients:", { underline: true });
    doc.fontSize(12);
    if (Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0) {
      recipe.ingredients.forEach((ing) => {
        doc.text(`- ${ing}`);
      });
    } else {
      doc.text("No ingredients provided");
    }
    doc.moveDown();

    doc.fontSize(16).text("Steps:", { underline: true });
    doc.fontSize(12);
    if (Array.isArray(recipe.steps) && recipe.steps.length > 0) {
      recipe.steps.forEach((step) => {
        doc.text(step);
        doc.moveDown(0.5);
      });
    } else {
      doc.text("No steps provided");
    }

    // Analytics: recipe exported to PDF
    const ctx = getEventContext(req);
    trackEvent("recipe_export_pdf", {
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      metadata: {
        title: recipe.title || "Untitled",
      },
    });

    doc.end();
  } catch (error) {
    console.error("❌ Backend error (exportRecipePdf):", error);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

// Simple contact support endpoint (used by in-app support form)
const RESEND_API_KEY = process.env.RESEND_API_KEY || process.env.SMTP_PASS;

async function handleContactSupport(req, res) {
  try {
    // Accept both `fromEmail` (preferred) and fallback `email` from the body
    const { subject, message, email: bodyEmail, fromEmail } = req.body || {};

    // Prefer fromEmail when present, otherwise use email
    const rawEmail =
      (typeof fromEmail === "string" && fromEmail.trim())
        ? fromEmail
        : (typeof bodyEmail === "string" ? bodyEmail : "");

    // Basic validation
    if (typeof subject !== "string" || !subject.trim()) {
      return res.status(400).json({ error: "Subject is required" });
    }
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }
    if (!rawEmail || !rawEmail.trim()) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Clean / normalize inputs
    const trimmedSubject = subject.replace(/[\r\n]/g, " ").trim().slice(0, 150);
    const trimmedMessage = message.trim().slice(0, 4000);
    const trimmedEmail = rawEmail.trim().slice(0, 254);

    // Simple email format check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    if (!RESEND_API_KEY) {
      console.error("❌ RESEND_API_KEY is not configured.");
      return res.status(500).json({ error: "Email service not configured" });
    }

    const toAddress = process.env.SUPPORT_EMAIL || "info@rafaelpiloto.com";
    const fromAddress = process.env.SMTP_FROM || "MyCookbook AI Support <no-reply@rafaelpiloto.com>";

    const payload = {
      from: fromAddress,
      to: toAddress,
      subject: `[MyCookbook AI Support] ${trimmedSubject}`,
      reply_to: trimmedEmail,
      text: [
        `Support message from: ${trimmedEmail}`,
        "",
        `Subject: ${trimmedSubject}`,
        "",
        "Message:",
        trimmedMessage,
      ].join("\n"),
    };

    console.log("[contact-support] Sending email via Resend API to:", toAddress);

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "<no body>");
      console.error("[contact-support] Resend API error:", response.status, errorText);
      return res.status(500).json({ error: "Failed to send support message" });
    }

    console.log("[contact-support] Email sent successfully via Resend HTTP API");

    // Analytics: contact support message sent
    const ctx = getEventContext(req);
    trackEvent("contact_support_sent", {
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      metadata: {
        subjectLength: trimmedSubject.length,
        messageLength: trimmedMessage.length,
        fromEmail: trimmedEmail,
      },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /contact-support error:", err?.message || err);
    return res.status(500).json({ error: "Failed to send support message" });
  }
}

// Expose both routes so the frontend can call either
app.post("/contact-support", handleContactSupport);
app.post("/support/contact", handleContactSupport);

// Import recipe from URL with layered strategy
app.post("/importRecipeFromUrl", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    console.error("❌ ImportRecipeFromUrl 400 - URL is required");
    return res.status(400).json({ error: "URL is required" });
  }

  // Reject non-http(s) URLs
  let _parsedUrl;
  try {
    _parsedUrl = new URL(url);
  } catch (e) {
    console.error("❌ ImportRecipeFromUrl 400 - Invalid URL:", url);
    return res.status(400).json({ error: "Invalid URL" });
  }
  if (!/^https?:$/.test(_parsedUrl.protocol)) {
    console.error("❌ ImportRecipeFromUrl 400 - Unsupported protocol:", _parsedUrl.protocol);
    return res.status(400).json({ error: "Only http:// or https:// URLs are supported" });
  }

  // Analytics: user attempted to import recipe from URL (only host stored for privacy)
  const ctx = getEventContext(req);
  trackEvent("import_recipe_from_url", {
    userId: ctx.userId,
    deviceId: ctx.deviceId,
    metadata: {
      host: _parsedUrl.host,
    },
  });

  // Helper to clean ingredient strings
  function cleanIngredient(str) {
    let out = he.decode(str).trim();
    out = out.replace(/\s+/g, " ");
    out = out.replace(/\b(tbsp|tsp|cup|cups|g|kg|ml|l)\s+\1\b/gi, "$1");
    out = out.replace(/\btbsp\b/gi, "tbsp");
    out = out.replace(/\btsp\b/gi, "tsp");
    out = out.replace(/\bcups?\b/gi, m => m.toLowerCase());
    return out;
  }

  // Helper for normalizing the scraped recipe
  function normalizeImportedRecipe(scraped, req) {
    // --- Cooking Time ---
    // Candidates: [totalTime, cookTime, prepTime], prefer first valid
    let cookingTime = 30;
    // Enhanced parseDuration to handle multi-hour and minute formats robustly
    function parseDuration(str) {
      if (typeof str === "number" && isFinite(str)) return str;
      if (typeof str !== "string") return null;
      // ISO8601: PT1H20M, PT35M, etc.
      let match = str.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
      if (match) {
        const hours = match[1] ? parseInt(match[1], 10) : 0;
        const mins = match[2] ? parseInt(match[2], 10) : 0;
        return hours * 60 + mins;
      }
      // e.g. "5 hours 15 minutes", "1 hr 20 mins", "2 hours 15 min", "35 minutes", "90 min total"
      // Find all hour and minute patterns
      let total = 0;
      // Match all hour groups
      const hourMatches = [...str.matchAll(/(\d+)\s*(?:h|hr|hour)s?/gi)];
      if (hourMatches.length > 0) {
        for (const m of hourMatches) {
          total += parseInt(m[1], 10) * 60;
        }
      }
      // Match all minute groups
      const minMatches = [...str.matchAll(/(\d+)\s*(?:m|min|minute|minutes)/gi)];
      if (minMatches.length > 0) {
        for (const m of minMatches) {
          total += parseInt(m[1], 10);
        }
      }
      if (total > 0) return total;
      // e.g. "90" (assume minutes)
      match = str.match(/(\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }
      return null;
    }
    // Candidates: prefer first valid (5–600 min)
    const timeCandidates = [scraped.totalTime, scraped.cookTime, scraped.prepTime];
    for (const cand of timeCandidates) {
      if (typeof cand === "number" && cand >= 5 && cand <= 600) {
        cookingTime = cand;
        break;
      } else if (typeof cand === "string") {
        const mins = parseDuration(cand);
        if (mins && mins >= 5 && mins <= 600) {
          cookingTime = mins;
          break;
        }
      }
    }
    // --- Difficulty ---
    let difficulty = typeof scraped.difficulty === "string" && scraped.difficulty.trim()
      ? scraped.difficulty.trim()
      : "Moderate";
    // --- Servings ---
    // Default to undefined, only fallback to 4 if nothing extracted
    let servings = undefined;
    // Improved extractServings implementation
    function extractServings(str) {
      if (typeof str !== "string") return null;
      // Multilingual patterns: servings, serves/makes, people/persons, porções/porcao, doses, comensales/comensais, raciones, "for N"
      let match =
        str.match(/\b(\d{1,4})\s*(servings?|people|persons?|porções?|porcao|doses?|dose|comensales|comensais|raciones?)\b/i) ||
        str.match(/\b(serves?|makes?)\s+(\d{1,4})\b/i) ||
        str.match(/\bfor\s+(\d{1,4})\b/i) ||
        str.match(/\b(\d{1,4})\s*(comensales|comensais)\b/i);
      if (match) {
        return parseInt(match[1] || match[2], 10);
      }
      // Fallback: if the string contains any number, assume it's the servings count
      const justNumber = str.match(/(\d{1,4})/);
      if (justNumber) return parseInt(justNumber[1], 10);
      return null;
    }
    // Try to extract servings from scraped.yield, then scraped.recipeYield
    let candidateServings = null;
    if (typeof scraped.yield === "string") {
      candidateServings = extractServings(scraped.yield);
    }
    if ((candidateServings === null || isNaN(candidateServings)) && typeof scraped.recipeYield === "string") {
      candidateServings = extractServings(scraped.recipeYield);
    }
    if (
      typeof candidateServings === "number" &&
      candidateServings > 0 &&
      candidateServings < 1000
    ) {
      servings = candidateServings;
    }
    // If still not set, fallback to 4
    if (
      typeof servings !== "number" ||
      !isFinite(servings) ||
      servings <= 0 ||
      servings >= 1000
    ) {
      servings = 4;
    }
    // Image: normalize to a string URL. Handle string, array, or object. Else fallback to default.
    let image = undefined;
    if (scraped.image) {
      if (typeof scraped.image === "string" && scraped.image.trim()) {
        let imgVal = scraped.image.trim();
        if (/^https?:\/\//i.test(imgVal)) {
          image = imgVal;
        } else {
          // Handle relative URL
          try {
            image = new URL(imgVal, req.protocol + "://" + req.get("host") + "/").href;
          } catch (e) {
            image = undefined;
          }
        }
      } else if (Array.isArray(scraped.image) && scraped.image.length > 0) {
        // Find first valid image (string or object with url)
        let foundImg = null;
        for (const img of scraped.image) {
          if (typeof img === "string" && img.trim()) {
            if (/^https?:\/\//i.test(img.trim())) {
              foundImg = img.trim();
              break;
            } else {
              // Relative URL
              try {
                foundImg = new URL(img.trim(), req.protocol + "://" + req.get("host") + "/").href;
                break;
              } catch (e) { }
            }
          } else if (img && typeof img === "object" && typeof img.url === "string" && img.url.trim()) {
            if (/^https?:\/\//i.test(img.url.trim())) {
              foundImg = img.url.trim();
              break;
            } else {
              try {
                foundImg = new URL(img.url.trim(), req.protocol + "://" + req.get("host") + "/").href;
                break;
              } catch (e) { }
            }
          }
        }
        if (foundImg) image = foundImg;
      } else if (typeof scraped.image === "object" && scraped.image.url && typeof scraped.image.url === "string" && scraped.image.url.trim()) {
        let imgVal = scraped.image.url.trim();
        if (/^https?:\/\//i.test(imgVal)) {
          image = imgVal;
        } else {
          // Relative URL
          try {
            image = new URL(imgVal, req.protocol + "://" + req.get("host") + "/").href;
          } catch (e) {
            image = undefined;
          }
        }
      }
    }
    // Fallback to default if nothing valid
    if (!image || typeof image !== "string" || !image.trim()) {
      image = `${req.protocol}://${req.get("host")}/assets/default_recipe.png`;
    }
    // Ingredients: filter array for valid strings that are not empty and do not contain "http" or "base64". Fallback ["No ingredients provided"].
    let ingredients = [];
    if (Array.isArray(scraped.ingredients)) {
      ingredients = scraped.ingredients.filter(
        (i) =>
          typeof i === "string" &&
          i.trim() &&
          !i.toLowerCase().includes("http") &&
          !i.toLowerCase().includes("base64")
      ).map(i => cleanIngredient(i));
    }
    // If no ingredients, try scraped.recipeIngredient (alternate JSON-LD property)
    if (!ingredients.length && Array.isArray(scraped.recipeIngredient)) {
      ingredients = scraped.recipeIngredient.filter(
        (i) =>
          typeof i === "string" &&
          i.trim() &&
          !i.toLowerCase().includes("http") &&
          !i.toLowerCase().includes("base64")
      ).map(i => cleanIngredient(i));
    }
    if (!ingredients.length) {
      ingredients = ["No ingredients provided"];
    }
    // Steps: from scraped.instructions, filter for valid strings not containing http. If none, fallback ["No steps provided"].
    let steps = [];
    // Support recipeInstructions as array of objects with "text" (JSON-LD style)
    if (Array.isArray(scraped.recipeInstructions) && scraped.recipeInstructions.length > 0) {
      // If objects with text, extract those
      let extracted = [];
      for (const ins of scraped.recipeInstructions) {
        if (typeof ins === "string" && ins.trim()) {
          extracted.push(ins.trim());
        } else if (ins && typeof ins === "object" && typeof ins.text === "string" && ins.text.trim()) {
          extracted.push(ins.text.trim());
        }
      }
      if (extracted.length) steps = extracted;
    }
    // Otherwise, fall back to scraped.instructions
    if (!steps.length && Array.isArray(scraped.instructions)) {
      steps = scraped.instructions.filter(
        (s) =>
          typeof s === "string" &&
          s.trim() &&
          !s.toLowerCase().includes("http")
      );
    }
    if (!steps.length && typeof scraped.instructions === "string" && scraped.instructions.trim() && !scraped.instructions.toLowerCase().includes("http")) {
      steps = [scraped.instructions.trim()];
    }
    if (!steps.length) {
      steps = ["No steps provided"];
    }
    // Decode HTML entities in steps
    steps = steps.map(s => he.decode(s.trim()));
    // Tags: from scraped.keywords string, split by commas. Else [].
    let tags = [];
    if (typeof scraped.keywords === "string" && scraped.keywords.trim()) {
      tags = scraped.keywords.split(",").map(t => he.decode(t.trim())).filter(Boolean);
    }
    // --- Normalize tags: deduplicate, trim, lowercase then capitalize, filter out tags > 50 chars, max 5 ---
    if (Array.isArray(tags)) {
      tags = Array.from(new Set(
        tags
          .map((t) =>
            t
              .toString()
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9\s]/gi, "")
          )
          .filter(Boolean)
          .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
      )).filter(t => t.length <= 50).slice(0, 5);
    }
    // Compose normalized object
    return {
      id: `${Date.now()}`,
      title: typeof scraped.name === "string" && scraped.name.trim()
        ? he.decode(scraped.name.trim())
        : (typeof scraped.title === "string" && scraped.title.trim() ? he.decode(scraped.title.trim()) : "Untitled Recipe"),
      cookingTime,
      difficulty,
      servings,
      cost: "Medium",
      ingredients,
      steps,
      tags,
      createdAt: new Date().toISOString(),
      image,
    };
  }

  try {
    // Fetch raw HTML with timeout and size limit (2 MB)
    const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s

    let response;
    try {
      response = await fetch(url, { signal: controller.signal, size: MAX_HTML_BYTES });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err && (err.name === 'AbortError' || err.type === 'aborted')) {
        console.error("❌ ImportRecipeFromUrl 408 - Fetch timeout for:", url);
        return res.status(408).json({ error: "Fetch timed out (15s)" });
      }
      if (err && (/max\s*size/i.test(String(err.message)) || err.type === 'max-size')) {
        console.error("❌ ImportRecipeFromUrl 413 - Response too large for:", url);
        return res.status(413).json({ error: "Response too large (>2MB)" });
      }
      console.error("❌ ImportRecipeFromUrl fetch error:", err);
      return res.status(502).json({ error: "Failed to fetch URL" });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      console.error("❌ ImportRecipeFromUrl fetch non-OK:", response.status, url);
      return res.status(502).json({ error: `Upstream responded with ${response.status}` });
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_HTML_BYTES) {
      try { response.body && response.body.cancel && response.body.cancel(); } catch (_) { }
      console.error("❌ ImportRecipeFromUrl 413 - Declared Content-Length too large:", contentLengthHeader);
      return res.status(413).json({ error: "Response too large (>2MB)" });
    }

    let html;
    try {
      html = await response.text();
    } catch (e) {
      console.error("❌ ImportRecipeFromUrl reading body failed:", e);
      return res.status(502).json({ error: "Failed to read response body" });
    }

    // Try JSON-LD
    const ldRecipes = extractJsonLd(html);
    if (ldRecipes.length > 0) {
      const safe = normalizeImportedRecipe(ldRecipes[0], req);
      return res.json({ recipe: safe });
    }

    // Try recipe-scraper
    try {
      const scraped = await scrapeRecipe(url);
      const safe = normalizeImportedRecipe(scraped, req);
      return res.json({ recipe: safe });
    } catch (e) {
      console.warn("recipe-scraper failed, trying heuristics.");
    }

    // BBC Good Food specific scraper
    if (url.includes("bbcgoodfood.com")) {
      const $ = cheerio.load(html);
      // Title
      const title = he.decode($("h1").first().text().trim());
      // Ingredients
      const ingredients = [];
      $("#recipe-ingredients li").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) ingredients.push(cleanIngredient(txt));
      });
      // Steps: from #method li and #method p
      const steps = [];
      $("#method li, #method p").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) steps.push(he.decode(txt));
      });
      // Servings (optional)
      let servings = undefined;
      const servingsText = $("section.recipe-details__item--servings").first().text().trim();
      if (servingsText) {
        const match = servingsText.match(/(\d+)/);
        if (match) servings = parseInt(match[1], 10);
      }
      // If any ingredients or steps found, normalize and return
      if (ingredients.length || steps.length) {
        const scraped = {
          name: title,
          ingredients,
          instructions: steps,
        };
        if (servings) scraped.yield = servings.toString();
        const safe = normalizeImportedRecipe(scraped, req);
        return res.json({ recipe: safe });
      }
    }

    // Continente specific scraper
    if (url.includes("feed.continente.pt")) {
      const $ = cheerio.load(html);
      const title = he.decode($("h1").first().text().trim());
      const ingredients = [];
      // Flexible selector: any element with class containing 'ingredient' (case-insensitive), then li children
      $("[class*='ingredient' i] li").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) {
          const cleaned = cleanIngredient(txt);
          if (cleaned) ingredients.push(cleaned);
        }
      });
      // Also allow direct ingredient class elements if not contained in a <ul>
      $("[class*='ingredient' i]").each((i, el) => {
        // If this element is an li and not already captured above
        if ($(el).is("li")) {
          const txt = $(el).text().trim();
          if (txt) {
            const cleaned = cleanIngredient(txt);
            if (cleaned && !ingredients.includes(cleaned)) ingredients.push(cleaned);
          }
        }
      });
      const steps = [];
      // Flexible selector: any element with class containing 'step', select li and p children
      $("[class*='step' i] li, [class*='step' i] p").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) {
          const decoded = he.decode(txt);
          if (decoded) steps.push(decoded);
        }
      });
      // Also allow direct step class elements if not contained in a list/paragraph
      $("[class*='step' i]").each((i, el) => {
        if ($(el).is("li") || $(el).is("p")) {
          const txt = $(el).text().trim();
          if (txt) {
            const decoded = he.decode(txt);
            if (decoded && !steps.includes(decoded)) steps.push(decoded);
          }
        }
      });
      if (ingredients.length || steps.length) {
        const scraped = {
          name: title,
          ingredients,
          instructions: steps,
        };
        const safe = normalizeImportedRecipe(scraped, req);
        return res.json({ recipe: safe });
      }
    }

    // TudoGostoso specific scraper
    if (url.includes("tudogostoso.com.br")) {
      const $ = cheerio.load(html);
      // Extract title from <h1>
      const title = he.decode($("h1").first().text().trim());
      // Ingredients: any element with class containing 'ingrediente'
      const ingredients = [];
      $("[class*='ingrediente' i]").each((i, el) => {
        // Only grab text from LI or direct ingredient class elements
        if ($(el).is("li") || $(el).is("span") || $(el).is("p") || $(el).is("div")) {
          const txt = $(el).text().trim();
          if (txt) {
            const cleaned = cleanIngredient(txt);
            if (cleaned) ingredients.push(cleaned);
          }
        }
      });
      // Steps extraction logic:
      let steps = [];

      // Try to find the "Modo de preparo" section and collect following paragraphs/lists
      const preparoHeader = $("h2:contains('Modo de preparo'), h3:contains('Modo de preparo')").first();
      if (preparoHeader.length) {
        let current = preparoHeader.next();
        while (current.length) {
          if (current.is("h2, h3")) break; // stop at next section
          if (current.is("p, li")) {
            const txt = current.text().trim();
            if (txt) {
              const decoded = he.decode(txt);
              if (decoded) steps.push(decoded);
            }
          }
          current = current.next();
        }
      }

      // Also allow fallback selectors
      if (!steps.length) {
        $("#preparoModo li, #preparoModo p").each((i, el) => {
          const txt = $(el).text().trim();
          if (txt) {
            const decoded = he.decode(txt);
            if (decoded) steps.push(decoded);
          }
        });
      }
      if (!steps.length) {
        $("[class*='preparo' i] li, [class*='preparo' i] p").each((i, el) => {
          const txt = $(el).text().trim();
          if (txt) {
            const decoded = he.decode(txt);
            if (decoded) steps.push(decoded);
          }
        });
      }

      // Image extraction:
      let image = null;
      const ogImg = $("meta[property='og:image']").attr("content");
      if (ogImg && /^https?:\/\/.+/i.test(ogImg.trim())) {
        image = ogImg.trim();
      } else {
        // Try first <img> in main recipe content containers
        let imgEl = $(".recipe-content img").first();
        if (!imgEl.length) imgEl = $(".container img").first();
        if (!imgEl.length) imgEl = $("img").first();
        if (imgEl && imgEl.attr("src") && /^https?:\/\/.+/i.test(imgEl.attr("src").trim())) {
          image = imgEl.attr("src").trim();
        }
      }
      // If any ingredients or steps found, normalize and return
      if (ingredients.length || steps.length) {
        const scraped = {
          name: title,
          ingredients,
          instructions: steps,
          image,
        };
        const safe = normalizeImportedRecipe(scraped, req);
        return res.json({ recipe: safe });
      }
    }

    // SaborIntenso specific scraper (robust, with stronger fallback heuristics)
    if (url.includes("saborintenso.com")) {
      const $ = cheerio.load(html);
      // Title: from .threadtitle h1 or h1
      let title = $(".threadtitle h1").first().text().trim();
      if (!title) title = $("h1").first().text().trim();
      title = he.decode(title);

      // --- Primary selectors ---
      let ingredients = [];
      $(".ingredients li").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) ingredients.push(cleanIngredient(txt));
      });
      // Fallback: .postcontent li
      if (!ingredients.length) {
        $(".postcontent li").each((i, el) => {
          const txt = $(el).text().trim();
          if (txt) ingredients.push(cleanIngredient(txt));
        });
      }

      // --- STRONGER FALLBACK for Ingredients: scan .postcontent children for "Ingrediente" header and subsequent siblings ---
      if (!ingredients.length) {
        $(".postcontent").each((_, postEl) => {
          let found = false;
          let foundLines = [];
          $(postEl).children().each((i, el) => {
            const elText = $(el).text().trim();
            // Look for header containing "Ingrediente"
            if (/ingrediente/i.test(elText)) {
              found = true;
              return; // continue to next sibling
            }
            if (found) {
              // Stop if we hit a section header that looks like "Observações", "Notas", "Dica"
              if (/observaç|nota|notas|dica|dicas/i.test(elText)) return false; // break
              // Otherwise, accumulate lines from HTML, replace <br> with \n, split, trim, decode
              let html = $(el).html() || "";
              html = html.replace(/<br\s*\/?>/gi, "\n");
              let lines = html.split(/\n/).map(l => he.decode(l.trim())).filter(Boolean);
              for (const line of lines) {
                const cleaned = cleanIngredient(line);
                if (cleaned) foundLines.push(cleaned);
              }
            }
          });
          if (foundLines.length) {
            ingredients = ingredients.concat(foundLines);
          }
        });
      }
      ingredients = Array.from(new Set(ingredients.filter(Boolean)));

      // --- Steps extraction ---
      let steps = [];
      $(".preparation p, .preparation li").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) steps.push(he.decode(txt));
      });
      // Fallback: .postcontent p, li
      if (!steps.length) {
        $(".postcontent p, .postcontent li").each((i, el) => {
          const txt = $(el).text().trim();
          if (txt) steps.push(he.decode(txt));
        });
      }

      // --- STRONGER FALLBACK for Steps: scan .postcontent for "Preparação" or "Modo de preparo" header and accumulate following siblings ---
      if (!steps.length) {
        $(".postcontent").each((_, postEl) => {
          let found = false;
          let foundSteps = [];
          $(postEl).children().each((i, el) => {
            const elText = $(el).text().trim();
            // Look for header containing "Preparação" or "Modo de preparo"
            if (/preparaç|modo de preparo/i.test(elText)) {
              found = true;
              return; // continue to next sibling
            }
            if (found) {
              // Stop if we hit another likely header (Observações, Nota, Dica, Ingrediente, etc.)
              if (/observaç|nota|notas|dica|dicas|ingrediente/i.test(elText)) return false; // break
              // Otherwise, accumulate lines from HTML, replace <br> with \n, split, trim, decode
              let html = $(el).html() || "";
              html = html.replace(/<br\s*\/?>/gi, "\n");
              let lines = html.split(/\n/).map(l => he.decode(l.trim())).filter(Boolean);
              for (const line of lines) {
                if (line) foundSteps.push(line);
              }
            }
          });
          if (foundSteps.length) {
            steps = steps.concat(foundSteps);
          }
        });
      }
      steps = Array.from(new Set(steps.filter(Boolean)));

      // --- Fallback: Heuristic parsing from .postcontent HTML ---
      let fallbackIngredients = [];
      let fallbackSteps = [];
      try {
        // Get raw HTML from .postcontent
        let postHtml = "";
        $(".postcontent").each((i, el) => {
          postHtml += $(el).html() || "";
        });
        // Normalize line breaks
        postHtml = postHtml.replace(/<br\s*\/?>/gi, "\n");
        // Remove excessive tags but keep headings and paragraphs
        // Heuristic: search for "Ingrediente" or "Ingredientes" section
        const lower = postHtml.toLowerCase();
        let ingStart = lower.indexOf("ingrediente");
        if (ingStart === -1) ingStart = lower.indexOf("ingredientes");
        if (ingStart !== -1) {
          // Find where "Preparação", "Modo de preparo", "Observações", etc. appear next
          let sectionEnd = lower.length;
          const sectionMarkers = [
            "preparaç", "modo de preparo", "observaç", "nota", "notas", "dica", "dicas", "preparation"
          ];
          for (const marker of sectionMarkers) {
            const idx = lower.indexOf(marker, ingStart + 10);
            if (idx !== -1 && idx < sectionEnd) sectionEnd = idx;
          }
          let ingBlock = postHtml.substring(ingStart, sectionEnd);
          // Split by newlines, remove HTML tags, clean up
          ingBlock = ingBlock.replace(/<[^>]+>/g, "\n");
          let lines = ingBlock.split(/\n/).map(s => s.trim()).filter(Boolean);
          // Remove lines that are likely headings or section markers
          lines = lines.filter(s => !/ingrediente/i.test(s) && !/preparaç|modo de preparo|observaç|nota|dica/i.test(s));
          fallbackIngredients = lines.map(cleanIngredient);
          fallbackIngredients = Array.from(new Set(fallbackIngredients.filter(Boolean)));
        }
        // Steps: search for "Preparação" or "Modo de preparo"
        let prepStart = lower.indexOf("preparaç");
        if (prepStart === -1) prepStart = lower.indexOf("modo de preparo");
        if (prepStart !== -1) {
          let sectionEnd = lower.length;
          const sectionMarkers = [
            "ingrediente", "observaç", "nota", "notas", "dica", "dicas", "ingredients"
          ];
          for (const marker of sectionMarkers) {
            const idx = lower.indexOf(marker, prepStart + 10);
            if (idx !== -1 && idx < sectionEnd) sectionEnd = idx;
          }
          let prepBlock = postHtml.substring(prepStart, sectionEnd);
          // Try splitting by <p>, <li>, or newlines
          let parts = [];
          // Try to split by <p>
          let pSplit = prepBlock.split(/<p[^>]*>/i).join("\n").replace(/<\/p>/gi, "\n");
          // Then split by <li>
          pSplit = pSplit.split(/<li[^>]*>/i).join("\n").replace(/<\/li>/gi, "\n");
          // Remove all other tags
          pSplit = pSplit.replace(/<[^>]+>/g, "");
          parts = pSplit.split(/\n/).map(s => s.trim()).filter(Boolean);
          // Remove lines that are section markers
          parts = parts.filter(s => !/preparaç|modo de preparo|ingrediente|observaç|nota|dica/i.test(s));
          fallbackSteps = parts.map(s => he.decode(s));
          fallbackSteps = Array.from(new Set(fallbackSteps.filter(Boolean)));
        }
      } catch (e) {
        // fallback parsing failed, ignore
      }
      // If fallback produced results, use them if primary is empty
      if (!ingredients.length && fallbackIngredients.length) {
        ingredients = fallbackIngredients;
      }
      if (!steps.length && fallbackSteps.length) {
        steps = fallbackSteps;
      }

      // Deduplicate
      ingredients = Array.from(new Set(ingredients.filter(Boolean)));
      steps = Array.from(new Set(steps.filter(Boolean)));

      // Servings: look for "Doses: N" in .postcontent or nearby
      let servings = undefined;
      let servingsText = "";
      $(".postcontent").each((i, el) => {
        const txt = $(el).text();
        if (txt && txt.includes("Doses:")) servingsText = txt;
      });
      if (!servingsText) {
        $("*").each((i, el) => {
          const txt = $(el).text();
          if (txt && txt.includes("Doses:")) servingsText = txt;
        });
      }
      if (servingsText) {
        const match = servingsText.match(/Doses:\s*(\d+)/i);
        if (match) servings = parseInt(match[1], 10);
      }
      // Image: .recipeimage img or first img in .postcontent
      let image = undefined;
      let imgEl = $(".recipeimage img").first();
      if (!imgEl.length) imgEl = $(".postcontent img").first();
      if (imgEl && imgEl.attr("src") && /^https?:\/\/.+/i.test(imgEl.attr("src").trim())) {
        image = imgEl.attr("src").trim();
      }
      // If any ingredients or steps found, normalize and return
      if (ingredients.length || steps.length) {
        const scraped = {
          name: title,
          ingredients,
          instructions: steps,
          image,
        };
        if (servings) scraped.yield = servings.toString();
        const safe = normalizeImportedRecipe(scraped, req);
        return res.json({ recipe: safe });
      }
    }

    // Food Network UK specific scraper (robust implementation)
    if (url.includes("foodnetwork.co.uk")) {
      const $ = cheerio.load(html);
      // Title from h1
      const title = he.decode($("h1").first().text().trim());
      // Ingredients: try multiple selectors, deduplicate and clean
      let ingredients = [];
      // .ingredients__list li
      $(".ingredients__list li").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) ingredients.push(he.decode(txt));
      });
      // [data-element-type='ingredients'] li
      $("[data-element-type='ingredients'] li").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) ingredients.push(he.decode(txt));
      });
      // .recipe-ingredients li
      $(".recipe-ingredients li").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) ingredients.push(he.decode(txt));
      });
      // Deduplicate and clean
      ingredients = Array.from(new Set(ingredients.map(s => s && s.trim()).filter(Boolean)))
        .map(i => cleanIngredient(i));

      // Steps: try multiple selectors, deduplicate and decode
      let steps = [];
      // .method__list li
      $(".method__list li").each((i, el) => {
        const txt = $(el).text();
        if (txt && txt.trim()) steps.push(he.decode(txt).trim());
      });
      // .method__list p
      $(".method__list p").each((i, el) => {
        const txt = $(el).text();
        if (txt && txt.trim()) steps.push(he.decode(txt).trim());
      });
      // [data-element-type='method-step']
      $("[data-element-type='method-step']").each((i, el) => {
        const txt = $(el).text();
        if (txt && txt.trim()) steps.push(he.decode(txt).trim());
      });
      // .method__steps li
      $(".method__steps li").each((i, el) => {
        const txt = $(el).text();
        if (txt && txt.trim()) steps.push(he.decode(txt).trim());
      });
      // .recipe-method li
      $(".recipe-method li").each((i, el) => {
        const txt = $(el).text();
        if (txt && txt.trim()) steps.push(he.decode(txt).trim());
      });
      // .method p
      $(".method p").each((i, el) => {
        const txt = $(el).text();
        if (txt && txt.trim()) steps.push(he.decode(txt).trim());
      });
      // --- ADDITIONAL SELECTORS ---
      // .instructions li, .instructions p
      $(".instructions li, .instructions p").each((i, el) => {
        const txt = $(el).text();
        if (txt && txt.trim()) steps.push(he.decode(txt).trim());
      });
      // [itemprop='recipeInstructions'] li, p, span
      $("[itemprop='recipeInstructions'] li, [itemprop='recipeInstructions'] p, [itemprop='recipeInstructions'] span").each((i, el) => {
        const txt = $(el).text();
        if (txt && txt.trim()) steps.push(he.decode(txt).trim());
      });
      // .directions li, .directions p
      $(".directions li, .directions p").each((i, el) => {
        const txt = $(el).text();
        if (txt && txt.trim()) steps.push(he.decode(txt).trim());
      });
      // Deduplicate and clean
      steps = Array.from(new Set(steps.map(s => s && s.trim()).filter(Boolean)));

      // If no steps found, fallback to broader selectors (ol li, ul li)
      if (!steps.length) {
        $("ol li, ul li").each((i, el) => {
          const txt = $(el).text();
          if (txt && txt.trim()) steps.push(he.decode(txt).trim());
        });
        steps = Array.from(new Set(steps.map(s => s && s.trim()).filter(Boolean)));
      }

      // Cooking time: parse from .recipe-meta li entries, sum hours and minutes
      let cookingTime = 0;
      let foundTime = false;
      $(".recipe-meta li").each((i, el) => {
        const txt = $(el).text().toLowerCase();
        let mins = 0;
        // Try to match hours
        const hrMatches = [...txt.matchAll(/(\d+)\s*(hour|hr|h)/g)];
        if (hrMatches.length > 0) {
          for (const m of hrMatches) mins += parseInt(m[1], 10) * 60;
        }
        // Try to match minutes
        const minMatches = [...txt.matchAll(/(\d+)\s*(minute|min|mins|m)/g)];
        if (minMatches.length > 0) {
          for (const m of minMatches) mins += parseInt(m[1], 10);
        }
        if (mins > 0) {
          cookingTime += mins;
          foundTime = true;
        }
      });
      // Fallback: use parseDuration on entire HTML if not found, or fallback to 30
      if (!foundTime || cookingTime < 5) {
        // parseDuration helper from above
        function parseDuration(str) {
          if (typeof str === "number" && isFinite(str)) return str;
          if (typeof str !== "string") return null;
          let match = str.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
          if (match) {
            const hours = match[1] ? parseInt(match[1], 10) : 0;
            const mins = match[2] ? parseInt(match[2], 10) : 0;
            return hours * 60 + mins;
          }
          let total = 0;
          const hourMatches = [...str.matchAll(/(\d+)\s*(?:h|hr|hour)s?/gi)];
          if (hourMatches.length > 0) {
            for (const m of hourMatches) total += parseInt(m[1], 10) * 60;
          }
          const minMatches = [...str.matchAll(/(\d+)\s*(?:m|min|minute|minutes)/gi)];
          if (minMatches.length > 0) {
            for (const m of minMatches) total += parseInt(m[1], 10);
          }
          if (total > 0) return total;
          match = str.match(/(\d+)/);
          if (match) return parseInt(match[1], 10);
          return null;
        }
        // Try to find a time string in HTML
        const metaTime = $(".recipe-meta li").map((i, el) => $(el).text()).get().join(" ");
        const parsed = parseDuration(metaTime);
        if (parsed && parsed >= 5) cookingTime = parsed;
        else cookingTime = 30;
      }
      // If any ingredients or steps found, normalize and return
      if (ingredients.length || steps.length) {
        const scraped = {
          name: title,
          ingredients,
          instructions: steps,
          totalTime: cookingTime
        };
        const safe = normalizeImportedRecipe(scraped, req);
        return res.json({ recipe: safe });
      }
    }

    // CyberCook specific scraper (improved servings and image extraction)
    if (url.includes("cybercook.com.br")) {
      const $ = cheerio.load(html);
      // Title
      const title = he.decode($("h1").first().text().trim());
      // Ingredients: .ingredientes li, .ingredientes-item, [itemprop='recipeIngredient']
      let ingredients = [];
      $(".ingredientes li, .ingredientes-item, [itemprop='recipeIngredient']").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) {
          const cleaned = cleanIngredient(txt);
          if (cleaned) ingredients.push(cleaned);
        }
      });
      ingredients = Array.from(new Set(ingredients.filter(Boolean)));
      // Steps: .preparo li, .preparo-item, [itemprop='recipeInstructions']
      let steps = [];
      $(".preparo li, .preparo-item, [itemprop='recipeInstructions']").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) {
          const decoded = he.decode(txt);
          if (decoded) steps.push(decoded);
        }
      });
      steps = Array.from(new Set(steps.filter(Boolean)));
      // Fallback: .preparo p, .modo-preparo p
      if (!steps.length) {
        $(".preparo p, .modo-preparo p").each((i, el) => {
          const txt = $(el).text().trim();
          if (txt) {
            const decoded = he.decode(txt);
            if (decoded) steps.push(decoded);
          }
        });
        steps = Array.from(new Set(steps.filter(Boolean)));
      }

      // --- Robust servings extraction ---
      let servings;
      let servingsText = "";
      // Try .yield, [itemprop='recipeYield'], .porcoes, .porcao, .doses, .serve, or any element containing these words
      servingsText =
        $(".yield").first().text().trim() ||
        $("[itemprop='recipeYield']").first().text().trim() ||
        $("[class*=porc]").first().text().trim() ||
        $("[class*=dose]").first().text().trim() ||
        $("[class*=serve]").first().text().trim();
      // Extra: if still nothing, try to capture <img alt="Porção"> + number
      if (!servingsText) {
        const altWithNumber = $("img[alt*='Porç'], img[alt*='porç']").parent().text().trim();
        if (altWithNumber) servingsText = altWithNumber;
      }
      // If still nothing, scan for any element containing "porções", "porcao", "doses", "serve"
      if (!servingsText) {
        const candidates = [];
        $("*").each((i, el) => {
          const txt = $(el).text().toLowerCase();
          if (
            /porç|porcao|doses|serve/.test(txt)
          ) {
            candidates.push($(el).text().trim());
          }
        });
        if (candidates.length) servingsText = candidates[0];
      }
      // As fallback, try body text
      if (!servingsText) {
        servingsText = $("body").text();
      }
      // Debug
      if (servingsText) console.log("CyberCook raw servings text:", servingsText);
      // Extract number from servingsText
      function extractServings(str) {
        if (typeof str !== "string") return null;
        // Look for patterns like "12 porções", "porções 12", "serve 4", "4 doses", "porcao 2", "doses: 8", etc.
        let match =
          str.match(/\b(\d{1,4})\s*(porç(?:[õo]es)?|porcao|doses?|serves?|serve|people|persons?)\b/i) ||
          str.match(/\b(porç(?:[õo]es)?|porcao|doses?|serves?|serve|people|persons?)\s*(\d{1,4})\b/i) ||
          str.match(/\b(serves?|makes?)\s+(\d{1,4})\b/i) ||
          str.match(/\bfor\s+(\d{1,4})\b/i);
        if (match) {
          return parseInt(match[1] || match[2], 10);
        }
        // Try just a number surrounded by whitespace or start/end
        match = str.match(/(?:^|\D)(\d{1,4})(?:\D|$)/);
        if (match) return parseInt(match[1], 10);
        return null;
      }
      if (servingsText) {
        const s = extractServings(servingsText);
        if (typeof s === "number" && s > 0 && s < 1000) servings = s;
      }

      // --- Robust image extraction ---
      let image = null;
      // Try meta og:image
      let imgCandidate = $("meta[property='og:image']").attr("content");
      if (!imgCandidate) {
        // Try .recipe-photo img, .foto-receita img, img[itemprop='image'], .card-recipe img, .recipe-image img
        let imgEl =
          $(".recipe-photo img").first();
        if (!imgEl.length) imgEl = $(".foto-receita img").first();
        if (!imgEl.length) imgEl = $("img[itemprop='image']").first();
        if (!imgEl.length) imgEl = $(".card-recipe img").first();
        if (!imgEl.length) imgEl = $(".recipe-image img").first();
        if (!imgEl.length) imgEl = $("img").first();
        // Try src, data-src, data-lazy-src, srcset
        if (imgEl.length) {
          imgCandidate =
            imgEl.attr("src") ||
            imgEl.attr("data-src") ||
            imgEl.attr("data-lazy-src") ||
            imgEl.attr("srcset");
        }
      }
      // Debug
      if (imgCandidate) console.log("CyberCook image candidate:", imgCandidate);
      // Normalize if present
      if (imgCandidate && typeof imgCandidate === "string" && imgCandidate.trim()) {
        image = imgCandidate.trim();
        // If srcset, pick the first URL
        if (image.includes(",")) {
          // srcset format: url1 200w, url2 400w, ...
          image = image.split(",")[0].split(/\s+/)[0];
        }
      }
      // Normalize relative URLs
      if (image && !/^https?:\/\//i.test(image)) {
        try {
          image = new URL(image, new URL(url).origin).href;
        } catch (e) {
          image = undefined;
        }
      }

      // Compose scraped object
      if (ingredients.length || steps.length) {
        const scraped = {
          name: title,
          ingredients,
          instructions: steps,
          image,
        };
        if (servings) scraped.yield = servings.toString();
        const safe = normalizeImportedRecipe(scraped, req);
        return res.json({ recipe: safe });
      }
    }

    // Receitas Nestlé Brasil specific scraper (com fetch “browser” e selectores corretos)
    if (url.includes("receitasnestle.com.br")) {
      // Fetch with headers emulating browser
      const responseNest = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
        }
      });
      const htmlNest = await responseNest.text();
      const $ = cheerio.load(htmlNest);

      // --- Title ---
      const title = he.decode($("h1").first().text().trim());

      // --- Ingredients ---
      let ingredients = [];
      $(".recipe-ingredients li, .ingredients__list li, [itemprop='recipeIngredient']").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) {
          const cleaned = cleanIngredient(txt);
          if (cleaned) ingredients.push(cleaned);
        }
      });
      ingredients = Array.from(new Set(ingredients.filter(Boolean)));

      // --- Steps (Modo de Preparo) ---
      let steps = [];
      $("#cook .cookSteps__item li .text, #cook .cookSteps__item li, #cook .cookSteps__item p").each((i, el) => {
        let txt = $(el).text();
        if (txt) {
          // remove any leading numbering like "1.", "1)", "1 -"
          txt = txt.replace(/^\s*\d+[\).\s-]*/, "").trim();
          const decoded = he.decode(txt);
          if (decoded) steps.push(decoded);
        }
      });
      steps = Array.from(new Set(steps.filter(Boolean)));

      // --- Servings ---
      let servings;
      let servingsText = $(".recipeDetail__infoItem--serving span").first().text().trim();
      if (!servingsText) {
        // Try variant where "Porções" is in a <strong> and number in a sibling <span>
        const li = $(".recipeDetail__infoItem--serving").first();
        if (li.length) {
          const alt = li.find("span").first().text().trim();
          if (alt) servingsText = alt;
        }
      }
      if (!servingsText) {
        // Last resort: any element that contains the word "Porções" and has a digit nearby
        const altBlock = $("strong:contains('Porções')").parent().text().trim();
        if (altBlock) servingsText = altBlock;
      }
      if (servingsText) {
        const m = servingsText.match(/(\d{1,4})/);
        if (m) servings = parseInt(m[1], 10);
      }

      // --- Cooking Time (opcional) ---
      let cookingTime;
      const timeText = $(".recipe-info__time, .recipe-time").first().text().trim();
      if (timeText) {
        const m = timeText.match(/(\d+)/);
        if (m) cookingTime = parseInt(m[1], 10);
      }

      // --- Image ---
      let image = null;
      // Prefer Open Graph image
      let imgCandidate = $("meta[property='og:image']").attr("content");
      if (!imgCandidate) {
        // Fallback: eager image or first image on page
        let imgEl = $("img[loading='eager']").first();
        if (!imgEl.length) imgEl = $("img").first();
        if (imgEl.length) {
          imgCandidate =
            imgEl.attr("src") ||
            imgEl.attr("data-src") ||
            imgEl.attr("data-original") ||
            imgEl.attr("srcset");
        }
      }
      if (imgCandidate) {
        let src = imgCandidate.trim();
        // If srcset, take the first URL (before any width descriptor)
        if (src.includes(",")) {
          src = src.split(",")[0].split(/\s+/)[0];
        }
        // Normalize relative URLs
        if (!/^https?:\/\//i.test(src)) {
          try {
            src = new URL(src, new URL(url).origin).href;
          } catch (e) {
            // ignore
          }
        }
        image = src;
      }

      if (ingredients.length || steps.length) {
        const scraped = {
          name: title,
          ingredients,
          instructions: steps,
          image,
        };
        if (servings) scraped.yield = servings.toString();
        if (cookingTime) scraped.totalTime = cookingTime;
        const safe = normalizeImportedRecipe(scraped, req);
        return res.json({ recipe: safe });
      }
    }

    // RecetasGratis specific scraper
    if (url.includes("recetasgratis.net")) {
      const $ = cheerio.load(html);

      // Title
      const title = he.decode($("h1").first().text().trim());

      // Ingredients
      let ingredients = [];
      $(".ingredientes li, .ingredientes-item, [itemprop='recipeIngredient']").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) {
          const cleaned = cleanIngredient(txt);
          if (cleaned) ingredients.push(cleaned);
        }
      });
      ingredients = Array.from(new Set(ingredients.filter(Boolean)));

      // Steps
      let steps = [];
      $(".preparacion li, .preparacion p, [itemprop='recipeInstructions']").each((i, el) => {
        const txt = $(el).text().trim();
        if (txt) {
          const decoded = he.decode(txt);
          if (decoded) steps.push(decoded);
        }
      });
      steps = Array.from(new Set(steps.filter(Boolean))).map((s, i) => `${i + 1}. ${s}`);

      // Servings
      let servings;
      const servingsText = $(".property.comensales").first().text().trim();
      if (servingsText) {
        const match = servingsText.match(/(\d+)/);
        if (match) servings = parseInt(match[1], 10);
      }

      // Image
      let image = null;
      const ogImg = $("meta[property='og:image']").attr("content");
      if (ogImg && /^https?:\/\//i.test(ogImg.trim())) {
        image = ogImg.trim();
      } else {
        const imgEl = $("img").first();
        if (imgEl && imgEl.attr("src")) {
          image = new URL(imgEl.attr("src"), url).href;
        }
      }

      if (ingredients.length || steps.length) {
        const scraped = {
          name: title,
          ingredients,
          instructions: steps,
          image,
        };
        if (servings) scraped.yield = servings.toString();
        const safe = normalizeImportedRecipe(scraped, req);
        return res.json({ recipe: safe });
      }
    }

    // Simple heuristic fallback (title + ingredients list from HTML)
    const $ = cheerio.load(html);
    const title = $("h1").first().text();
    const ingredients = $("li:contains(ingred)").map((i, el) => $(el).text()).get();

    if (title && ingredients.length) {
      const safe = normalizeImportedRecipe({ title, ingredients, instructions: [] }, req);
      return res.json({ recipe: safe });
    }

    // ---------- Generic multilanguage fallback ----------
    try {
      const ldRecipesGeneric = extractJsonLd(html);
      if (ldRecipesGeneric.length > 0) {
        const safe = normalizeImportedRecipe(ldRecipesGeneric[0], req);
        return res.json({ recipe: safe });
      }
    } catch (e) {
      console.warn("Generic JSON-LD extract failed");
    }

    try {
      const scrapedGeneric = await scrapeRecipe(url);
      const safe = normalizeImportedRecipe(scrapedGeneric, req);
      return res.json({ recipe: safe });
    } catch (e) {
      console.warn("Generic recipe-scraper failed, trying heuristics.");
    }

    // Heuristic multilanguage extraction
    const $generic = cheerio.load(html);
    let genIngredients = [];
    $generic("[itemprop='recipeIngredient'], .ingredients li, .ingredientes li, .zutaten li, .ingrédients li").each((i, el) => {
      const txt = $generic(el).text().trim();
      if (txt) genIngredients.push(cleanIngredient(txt));
    });

    let genSteps = [];
    $generic("[itemprop='recipeInstructions'], .method li, .preparation li, .zubereitung li, .préparation li").each((i, el) => {
      const txt = $generic(el).text().trim();
      if (txt) genSteps.push(he.decode(txt));
    });

    let genTitle = $generic("h1").first().text().trim() || $generic("title").text().trim();
    genTitle = he.decode(genTitle);

    if (genIngredients.length || genSteps.length) {
      const safe = normalizeImportedRecipe({ name: genTitle, ingredients: genIngredients, instructions: genSteps }, req);
      return res.json({ recipe: safe });
    }

    console.error("❌ ImportRecipeFromUrl 422 - Could not detect recipe structure");

    // Final fallback → AI (only if enabled)
    if (process.env.ENABLE_AI_FALLBACK === "true") {
      try {
        const prompt = `
Extract a recipe from the following HTML. Return ONLY valid JSON:

{
  "title": "string",
  "cookingTime": number,
  "difficulty": "Easy" | "Moderate" | "Challenging",
  "servings": number,
  "cost": "Cheap" | "Medium" | "Expensive",
  "ingredients": ["..."],
  "steps": ["..."],
  "tags": ["..."]
}

HTML (truncated):
"""
${html.slice(0, 6000)}
"""`;

        const completion = await client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are a chef assistant. Output valid JSON only." },
            { role: "user", content: prompt }
          ],
          temperature: 0.3,
          timeout: 10000,
        });

        let raw = completion.choices[0].message.content.trim();
        if (raw.startsWith("```")) {
          raw = raw.replace(/```(json)?/gi, "").replace(/```/g, "").trim();
        }

        const parsed = JSON.parse(raw);
        const safe = normalizeImportedRecipe(parsed, req);
        return res.json({ recipe: safe });

      } catch (err) {
        console.error("❌ AI fallback failed:", err);
        return res.status(422).json({ error: "Could not extract recipe, even with AI fallback" });
      }
    }

    // If AI disabled
    return res.status(422).json({
      errorCode: "INVALID_RECIPE_STRUCTURE"
      // error: "We could not detect a valid recipe structure in the provided link. Please double-check the URL or try another recipe website."
    });

  } catch (error) {
    console.error("❌ ImportRecipeFromUrl 500 - Exception:", error);
    res.status(500).json({ error: "Failed to import recipe from URL" });
  }
});

app.post("/importRecipeFromImage", upload.single("image"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "Image file is required" });
    }

    const { data: { text } } = await Tesseract.recognize(req.file.buffer, "eng+por+spa+fra+ita");

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "No text detected in image" });
    }

    // Determine language from request or OCR text
    let language = req.body && req.body.language ? normalizeLanguage(req.body.language) : null;
    const detectedLang = franc(text);
    console.log("Detected language from OCR text:", detectedLang);
    if (!language) {
      // Map franc code to canonical language
      const map = { por: "Portuguese", spa: "Spanish", fra: "French", deu: "German", ita: "Italian", eng: "English" };
      language = map[detectedLang] || "English";
    }

    const prompt = `
You are a professional chef assistant. Extract a detailed recipe from the following text. Return ONLY valid JSON matching this structure.

{
  "title": "string",
  "cookingTime": number,  // minutes (5–180 realistic range)
  "difficulty": "Easy" | "Moderate" | "Challenging",
  "servings": number,     // 1–999
  "cost": "Cheap" | "Medium" | "Expensive",
  "ingredients": ["list of ingredients with quantities"],
  "steps": ["step-by-step preparation instructions"],
  "tags": ["short tags like Vegan, Vegetarian, Gluten-Free, Dinner, Breakfast"]
}

Text:
"""
${text.trim()}
"""
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a professional chef assistant. Always reply ONLY with valid JSON that matches the schema provided.`,
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    });

    const raw = completion.choices[0].message.content.trim();
    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error("⚠️ Invalid JSON from AI for OCR recipe extraction:", err);
      return res.status(500).json({ error: "Failed to parse recipe JSON from OCR text" });
    }

    const safe = validateRecipe(parsed, null);
    res.json({ recipe: safe });
  } catch (error) {
    console.error("❌ Backend error (importRecipeFromImage):", error);
    res.status(500).json({ error: "Failed to import recipe from image" });
  }
});

/** ---------------------------
 * Start server
 * --------------------------*/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});