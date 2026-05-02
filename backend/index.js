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
import OpenAI, { toFile } from "openai";
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
import { google } from "googleapis";
import {
  getSupportedImportFormats,
  parseImportedRecipes,
  toImportErrorResponse,
} from "./importers/index.js";
import {
  extractRecipeFromHtml,
  recordUrlImportTelemetry,
} from "./services/importUrl.js";
import {
  SUPPORTED_INGREDIENT_LOCALES,
  normalizeAlias,
  normalizeAliases,
  shouldAutoPromoteCandidate,
} from "./ingredientCatalog.js";
import {
  INGREDIENT_CATALOG_SEED_ITEMS,
  INGREDIENT_CATALOG_SEED_MANIFEST,
} from "./ingredientCatalogSeed.js";

import admin from "firebase-admin";
import { Firestore } from "@google-cloud/firestore";

import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INGREDIENT_CATALOG_DOC_PATH = "ingredientCatalog/default";
const MEAL_PHRASE_RULES_DOC_PATH = "mealPhraseRules/default";
const MEAL_TEXT_RESOLVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MEAL_TEXT_RESOLVE_CACHE_MAX = 500;
const mealTextResolveCache = new Map();

function ingredientCatalogDocRef(db) {
  return db.doc(INGREDIENT_CATALOG_DOC_PATH);
}

function ingredientCatalogItemsCol(db) {
  return ingredientCatalogDocRef(db).collection("items");
}

function ingredientCatalogCandidatesCol(db) {
  return ingredientCatalogDocRef(db).collection("candidates");
}

function mealPhraseRulesDocRef(db) {
  return db.doc(MEAL_PHRASE_RULES_DOC_PATH);
}

function mealPhraseRuleCandidatesCol(db) {
  return mealPhraseRulesDocRef(db).collection("candidates");
}

function normalizeMealTextResolveCacheKey(input, language) {
  return `${normalizeLanguage(language)}:${String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()}`;
}

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getMealTextResolveCache(key) {
  const cached = mealTextResolveCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > MEAL_TEXT_RESOLVE_CACHE_TTL_MS) {
    mealTextResolveCache.delete(key);
    return null;
  }
  return cached.value;
}

function setMealTextResolveCache(key, value) {
  if (mealTextResolveCache.size >= MEAL_TEXT_RESOLVE_CACHE_MAX) {
    const oldestKey = mealTextResolveCache.keys().next().value;
    if (oldestKey) mealTextResolveCache.delete(oldestKey);
  }
  mealTextResolveCache.set(key, {
    createdAt: Date.now(),
    value,
  });
}

async function persistMealPhraseRuleCandidate({
  input,
  language,
  parsedIngredients,
  result,
}) {
  if (!_adminInitialized || !input || !result) return;
  const now = Date.now();
  const db = getAnalyticsDb();
  const cacheKey = normalizeMealTextResolveCacheKey(input, language);
  const readableId = cacheKey
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  const candidateId = `${readableId || "phrase"}_${stableHash(cacheKey)}`;
  await mealPhraseRuleCandidatesCol(db).doc(candidateId).set(
    {
      input: String(input || "").trim(),
      language: normalizeLanguage(language),
      parsedIngredients: Array.isArray(parsedIngredients) ? parsedIngredients : [],
      title: result.title,
      ingredients: result.ingredients,
      nutrition: result.nutrition,
      confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null,
      source: "describe_meal_ai",
      status: "candidate",
      createdAt: now,
      updatedAt: now,
      _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

function ingredientCatalogItemIdFromName(name) {
  return normalizeAlias(name).replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || `ingredient_${Date.now()}`;
}

function mergeLocalizedAliases(existing = {}, incoming = {}) {
  const merged = {};
  for (const locale of SUPPORTED_INGREDIENT_LOCALES) {
    merged[locale] = Array.from(
      new Set([
        ...(Array.isArray(existing[locale]) ? existing[locale] : []),
        ...(Array.isArray(incoming[locale]) ? incoming[locale] : []),
      ].map((value) => normalizeAlias(value)).filter(Boolean))
    );
  }
  return merged;
}

function serializeIngredientCatalogItem(id, raw = {}) {
  return {
    id,
    canonicalName: String(raw.canonicalName || "").trim(),
    category: raw.category ?? null,
    aliases: normalizeAliases(raw.aliases || {}),
    nutritionPer100: raw.nutritionPer100 || null,
    defaultServing: raw.defaultServing || null,
    source: raw.source || "seed",
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
}

function getSeedCatalogMap() {
  return INGREDIENT_CATALOG_SEED_ITEMS.reduce((acc, item) => {
    acc[item.id] = serializeIngredientCatalogItem(item.id, item);
    return acc;
  }, {});
}

async function getCombinedIngredientCatalogItems(db) {
  const seedMap = getSeedCatalogMap();
  if (!_adminInitialized || !db) {
    return Object.values(seedMap);
  }

  const snap = await ingredientCatalogItemsCol(db).get();
  for (const doc of snap.docs) {
    seedMap[doc.id] = serializeIngredientCatalogItem(doc.id, doc.data() || {});
  }
  return Object.values(seedMap).sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
}

async function persistIngredientCatalogCandidate({
  db,
  candidate,
  submittedByUid = null,
}) {
  const now = Date.now();
  const scored = shouldAutoPromoteCandidate(candidate);
  const candidateId = String(
    candidate.id || `candidate_${now}_${Math.random().toString(36).slice(2, 8)}`
  );

  const candidatePayload = {
    canonicalName: normalizeAlias(candidate.canonicalName || ""),
    category: candidate.category ?? null,
    aliases: scored.normalized.aliases,
    nutritionPer100: scored.normalized.nutritionPer100,
    defaultServing: scored.normalized.defaultServing,
    sourceText: typeof candidate.sourceText === "string" ? candidate.sourceText : null,
    confidence: Number.isFinite(Number(candidate.confidence))
      ? Number(candidate.confidence)
      : null,
    suggestedBy: "ai",
    createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : now,
    submittedByUid: submittedByUid || null,
    autoPromotion: {
      shouldPromote: scored.shouldPromote,
      score: scored.score,
      reasons: scored.reasons,
    },
    status: scored.shouldPromote ? "promoted" : "candidate",
    updatedAt: now,
    _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await ingredientCatalogCandidatesCol(db).doc(candidateId).set(candidatePayload, { merge: true });

  let promotedItem = null;
  let localEntry = serializeIngredientCatalogItem(candidateId, {
    canonicalName: candidatePayload.canonicalName,
    category: candidatePayload.category,
    aliases: candidatePayload.aliases,
    nutritionPer100: candidatePayload.nutritionPer100,
    defaultServing: candidatePayload.defaultServing,
    source: "ai_resolved",
    updatedAt: now,
  });

  if (scored.shouldPromote && scored.normalized.nutritionPer100 && scored.normalized.defaultServing) {
    const itemId = ingredientCatalogItemIdFromName(candidatePayload.canonicalName);
    const itemRef = ingredientCatalogItemsCol(db).doc(itemId);
    const existingSnap = await itemRef.get();
    const existing = existingSnap.exists ? existingSnap.data() || {} : {};

    const mergedItem = {
      canonicalName: candidatePayload.canonicalName,
      category: candidatePayload.category ?? existing.category ?? null,
      aliases: mergeLocalizedAliases(existing.aliases || {}, candidatePayload.aliases || {}),
      nutritionPer100: candidatePayload.nutritionPer100,
      defaultServing: candidatePayload.defaultServing,
      source: "ai_promoted",
      updatedAt: now,
      _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await itemRef.set(mergedItem, { merge: true });

    const itemsSnap = await ingredientCatalogItemsCol(db).get();
    await upsertIngredientCatalogManifest(db, {
      version: String(now),
      updatedAt: now,
      itemCount: itemsSnap.size,
    });

    promotedItem = serializeIngredientCatalogItem(itemId, mergedItem);
    localEntry = promotedItem;
  }

  return {
    candidateId,
    scored,
    candidatePayload,
    item: promotedItem,
    localEntry,
  };
}

async function upsertIngredientCatalogManifest(db, updates = {}) {
  const now = Date.now();
  await ingredientCatalogDocRef(db).set(
    {
      version: String(updates.version || now),
      updatedAt: typeof updates.updatedAt === "number" ? updates.updatedAt : now,
      locales: SUPPORTED_INGREDIENT_LOCALES,
      itemCount: typeof updates.itemCount === "number" ? updates.itemCount : 0,
      _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}


function loadGooglePlayServiceAccount() {
  // 1) Prefer FILE (Render secret file)
  const filePath = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE;
  if (filePath) {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  }

  // 2) Fallback to JSON env var (local/dev)
  const jsonStr = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (jsonStr) {
    return JSON.parse(jsonStr);
  }

  throw new Error("Missing Google Play service account config. Set GOOGLE_PLAY_SERVICE_ACCOUNT_FILE or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.");
}

// ---------------- Google Play purchase verification (Server-side) ----------------
// We verify purchases using Google Play Developer API.
// Required envs:
// - ANDROID_PACKAGE_NAME (e.g. ai.mycookbook.app)
// - GOOGLE_PLAY_SERVICE_ACCOUNT_FILE (Render secret file path) OR GOOGLE_PLAY_SERVICE_ACCOUNT_JSON

const ANDROID_PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME || "";

let _playPublisherClient = null;
function getPlayPublisherClient() {
  if (_playPublisherClient) return _playPublisherClient;

  const svc = loadGooglePlayServiceAccount();
  const auth = new google.auth.GoogleAuth({
    credentials: svc,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });

  _playPublisherClient = google.androidpublisher({
    version: "v3",
    auth,
  });

  return _playPublisherClient;
}

function isPlayVerifierConfigured() {
  const hasPkg = typeof ANDROID_PACKAGE_NAME === "string" && ANDROID_PACKAGE_NAME.trim().length > 0;
  const hasFile = !!process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE;
  const hasJson = !!process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  return hasPkg && (hasFile || hasJson);
}

async function verifyGooglePlayInAppPurchase({ packageName, productId, purchaseToken }) {
  const pkg = String(packageName || ANDROID_PACKAGE_NAME || "").trim();
  const pid = String(productId || "").trim();
  const token = String(purchaseToken || "").trim();

  if (!pkg) {
    const err = new Error("Missing Android package name");
    err.code = "MISSING_PACKAGE_NAME";
    throw err;
  }
  if (!pid || !token) {
    const err = new Error("Missing productId or purchaseToken");
    err.code = "MISSING_PURCHASE_FIELDS";
    throw err;
  }

  const publisher = getPlayPublisherClient();

  // In-app products (consumables/non-consumables): purchases.products.get
  const resp = await publisher.purchases.products.get({
    packageName: pkg,
    productId: pid,
    token,
  });

  const data = resp && resp.data ? resp.data : {};

  // purchaseState: 0 Purchased, 1 Canceled, 2 Pending
  // Note: for some products, fields can be missing; default to safe values.
  const purchaseState = typeof data.purchaseState === "number" ? data.purchaseState : null;
  const consumptionState = typeof data.consumptionState === "number" ? data.consumptionState : null;
  const acknowledgementState = typeof data.acknowledgementState === "number" ? data.acknowledgementState : null;

  const orderId = typeof data.orderId === "string" ? data.orderId : null;
  const purchaseTimeMillis = typeof data.purchaseTimeMillis === "string" ? Number(data.purchaseTimeMillis) : null;

  return {
    ok: true,
    packageName: pkg,
    productId: pid,
    purchaseToken: token,
    purchaseState,
    consumptionState,
    acknowledgementState,
    orderId,
    purchaseTimeMillis: Number.isFinite(purchaseTimeMillis) ? purchaseTimeMillis : null,
    raw: data,
  };
}


const app = express();

app.use(cors());
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("Cook N'Eat AI backend is running ✅");
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

// ---------------- Economy (Cookies) – MVP server-side enforcement ----------------
// NOTE: For MVP, pricing/limits are hardcoded in the backend as requested.
// We enforce cookies only when Firestore is available; otherwise we fail open to avoid breaking the app.
const ECONOMY_ENABLED =
  process.env.ECONOMY_ENABLED !== "0" &&
  process.env.ECONOMY_ENABLED !== "false";

// MVP cookie economics
const ECONOMY_LIMITS = {
  // How many premium actions a brand-new user can use before cookies are needed
  FREE_PREMIUM_ACTIONS_STARTING: 25,
  // How many cookies a brand-new user/device starts with
  STARTING_COOKIES: 10,
  // Extra cookies granted once, on the user's first non-anonymous login
  SIGNUP_BONUS_COOKIES: 10,
  REWARD_PROFILE_HEALTH_GOALS_COOKIES: 3,
  REWARD_FIRST_RECIPE_SAVED_COOKIES: 2,
  REWARD_RECIPES_10_COOKIES: 3,
  REWARD_RECIPES_25_COOKIES: 5,
  REWARD_FIRST_MEAL_LOGGED_COOKIES: 2,
  REWARD_MEALS_10_COOKIES: 3,
  REWARD_MEALS_25_COOKIES: 5,
  REWARD_FIRST_COOKBOOK_CREATED_COOKIES: 3,
  REWARD_FIRST_INSTAGRAM_REEL_IMPORT_COOKIES: 3,

  // Cookie costs (Import from URL is FREE for now)
  COST_AI_RECIPE_SUGGESTIONS: 0,
  COST_AI_RECIPE_FULL: 1,
  COST_IMPORT_INSTAGRAM_REEL: 2,
  COST_RECIPE_NUTRITION_ESTIMATE: 1,
  COST_MEAL_PHOTO_LOG: 1,
  COST_DESCRIBE_MEAL: 0,

  // Cookbooks are a core feature and should always be free.
  FREE_CUSTOM_COOKBOOKS: 0,
  COST_EXTRA_COOKBOOK: 0,
};

const INSTAGRAM_IMPORT_MIN_CONFIDENCE = 0.6;
const INSTAGRAM_TRANSCRIPTION_MAX_BYTES = 15 * 1024 * 1024;


// ---- Economy contract helpers (keep responses consistent + backward compatible) ----
const ECONOMY_ERROR_CODES = {
  NOT_ENOUGH_COOKIES: "ECON_NOT_ENOUGH_COOKIES",
};

const PREMIUM_ACTION_COSTS = {
  ai_recipe_full: ECONOMY_LIMITS.COST_AI_RECIPE_FULL,
  recipe_nutrition_estimate: ECONOMY_LIMITS.COST_RECIPE_NUTRITION_ESTIMATE,
  meal_photo_log: ECONOMY_LIMITS.COST_MEAL_PHOTO_LOG,
  describe_meal: ECONOMY_LIMITS.COST_DESCRIBE_MEAL,
  recipe_meal_estimate: ECONOMY_LIMITS.COST_RECIPE_NUTRITION_ESTIMATE,
  import_instagram_reel: ECONOMY_LIMITS.COST_IMPORT_INSTAGRAM_REEL,
};

const ECONOMY_REWARD_DEFS = {
  profile_health_goals_v1: {
    amount: ECONOMY_LIMITS.REWARD_PROFILE_HEALTH_GOALS_COOKIES,
    reason: "reward_profile_health_goals",
    bonusId: "profile_health_goals_v1",
    title: "Complete profile + Health & Goals",
    description: "Complete your profile and Health & Goals.",
    badges: ["✅ Setup reward"],
    action: "open_my_day_health_goals",
  },
  first_recipe_saved_v1: {
    amount: ECONOMY_LIMITS.REWARD_FIRST_RECIPE_SAVED_COOKIES,
    reason: "reward_first_recipe_saved",
    bonusId: "first_recipe_saved_v1",
    title: "Save your first recipe",
    description: "Save your first recipe.",
    badges: ["📘 First recipe"],
    action: "open_recipe_picker",
  },
  recipes_10_v1: {
    amount: ECONOMY_LIMITS.REWARD_RECIPES_10_COOKIES,
    reason: "reward_recipes_10",
    bonusId: "recipes_10_v1",
    title: "Save 10 recipes",
    description: "Save 10 recipes.",
    badges: [],
    action: "open_recipe_picker",
    prerequisiteRewardKey: "first_recipe_saved_v1",
    sortOrder: 25,
  },
  recipes_25_v1: {
    amount: ECONOMY_LIMITS.REWARD_RECIPES_25_COOKIES,
    reason: "reward_recipes_25",
    bonusId: "recipes_25_v1",
    title: "Save 25 recipes",
    description: "Save 25 recipes.",
    badges: [],
    action: "open_recipe_picker",
    prerequisiteRewardKey: "recipes_10_v1",
    sortOrder: 26,
  },
  first_meal_logged_v1: {
    amount: ECONOMY_LIMITS.REWARD_FIRST_MEAL_LOGGED_COOKIES,
    reason: "reward_first_meal_logged",
    bonusId: "first_meal_logged_v1",
    title: "Log your first meal",
    description: "Log your first meal in My Day.",
    badges: ["🍽️ First meal"],
    action: "open_my_day",
  },
  meals_10_v1: {
    amount: ECONOMY_LIMITS.REWARD_MEALS_10_COOKIES,
    reason: "reward_meals_10",
    bonusId: "meals_10_v1",
    title: "Log 10 meals",
    description: "Log 10 meals in My Day.",
    badges: [],
    action: "open_my_day",
    prerequisiteRewardKey: "first_meal_logged_v1",
    sortOrder: 35,
  },
  meals_25_v1: {
    amount: ECONOMY_LIMITS.REWARD_MEALS_25_COOKIES,
    reason: "reward_meals_25",
    bonusId: "meals_25_v1",
    title: "Log 25 meals",
    description: "Log 25 meals in My Day.",
    badges: [],
    action: "open_my_day",
    prerequisiteRewardKey: "meals_10_v1",
    sortOrder: 36,
  },
  first_cookbook_created_v1: {
    amount: ECONOMY_LIMITS.REWARD_FIRST_COOKBOOK_CREATED_COOKIES,
    reason: "reward_first_cookbook_created",
    bonusId: "first_cookbook_created_v1",
    title: "Create your first cookbook",
    description: "Create your first cookbook.",
    badges: ["📚 First cookbook"],
    action: "open_history_cookbooks",
  },
  first_instagram_reel_import_v1: {
    amount: ECONOMY_LIMITS.REWARD_FIRST_INSTAGRAM_REEL_IMPORT_COOKIES,
    reason: "reward_first_instagram_reel_import",
    bonusId: "first_instagram_reel_import_v1",
    title: "Import your first Instagram Reel",
    description: "Import your first recipe from an Instagram Reel.",
    badges: [],
    action: "open_recipe_picker",
    sortOrder: 50,
  },
};

const ECONOMY_OFFERS = [
  {
    id: "cookies_15",
    sku: "cookies_15",
    productId: "cookies_15",
    title: "15 Eggs",
    subtitle: null,
    price: 0.99,
    currency: "USD",
    cookies: 15,
    bonusCookies: 0,
    badges: [],
    isPromo: false,
    sortOrder: 10,
    mostPurchased: false,
  },
  {
    id: "cookies_50",
    sku: "cookies_50",
    productId: "cookies_50",
    title: "40 Eggs",
    subtitle: "",
    price: 2.99,
    currency: "USD",
    cookies: 40,
    bonusCookies: 10, // 25%
    badges: ["⭐ Bestseller", "🎁 +25% bonus"],
    isPromo: true,
    sortOrder: 20,
    mostPurchased: false,
  },
  {
    id: "cookies_120",
    sku: "cookies_120",
    productId: "cookies_120",
    title: "100 Eggs",
    subtitle: "",
    price: 5.99,
    currency: "USD",
    cookies: 100,
    bonusCookies: 25, // 25%
    badges: ["🎁 +25% bonus"],
    isPromo: true,
    sortOrder: 30,
    mostPurchased: false,
  },
  {
    id: "cookies_300",
    sku: "cookies_300",
    productId: "cookies_300",
    title: "240 Eggs",
    subtitle: "",
    price: 11.99,
    currency: "USD",
    cookies: 240,
    bonusCookies: 60, // 25%
    badges: ["🔥 Biggest pack", "🎁 +25% bonus"],
    isPromo: true,
    sortOrder: 40,
    mostPurchased: false,
  },
];
// Billing (Google Play) switch.
// You can ship the UI + backend contract first, and only enable billing later.
// - ECONOMY_BILLING_ENABLED=1 (or true) enables /economy/purchases/verify logic.
// - Otherwise the endpoint returns a stable "disabled" response.
const ECONOMY_BILLING_ENABLED =
  process.env.ECONOMY_BILLING_ENABLED === "1" ||
  process.env.ECONOMY_BILLING_ENABLED === "true";

// Optional: allow a dev-only cookie grant endpoint in non-production.
const ECONOMY_DEV_GRANT_ENABLED =
  (process.env.ECONOMY_DEV_GRANT_ENABLED === "1" ||
    process.env.ECONOMY_DEV_GRANT_ENABLED === "true") &&
  process.env.NODE_ENV !== "production";

function respondNotEnoughCookies(res, {
  action,
  requiredCookies,
  balance,
  remainingFreePremiumActions,
  message,
  offerId,
} = {}) {
  const required =
    typeof requiredCookies === "number" && Number.isFinite(requiredCookies)
      ? requiredCookies
      : 1;

  const remaining =
    typeof balance === "number" && Number.isFinite(balance)
      ? balance
      : 0;

  // Backward compatible:
  // - `error` and `remaining` are already used by your client in some places.
  return res.status(402).json({
    ok: false,
    error: "insufficient_cookies",
    code: ECONOMY_ERROR_CODES.NOT_ENOUGH_COOKIES,
    action: typeof action === "string" ? action : "unknown",
    requiredCookies: required,
    remaining,
    balance: remaining,
    remainingFreePremiumActions:
      typeof remainingFreePremiumActions === "number" &&
      Number.isFinite(remainingFreePremiumActions)
        ? Math.max(0, Math.floor(remainingFreePremiumActions))
        : 0,
    offerId: typeof offerId === "string" ? offerId : ECONOMY_OFFERS[0]?.id,
    message:
      typeof message === "string" && message.trim()
        ? message
        : "You do not have enough Eggs.",
  });
}

function getOfferBySku(sku) {
  if (!sku) return null;
  const s = String(sku).trim();
  return (
    ECONOMY_OFFERS.find(
      (o) => o && (o.sku === s || o.id === s || o.productId === s)
    ) || null
  );
}

function getTotalCookiesFromOffer(offer) {
  if (!offer) return 0;
  const base = typeof offer.cookies === "number" && Number.isFinite(offer.cookies) ? offer.cookies : 0;
  const bonus = typeof offer.bonusCookies === "number" && Number.isFinite(offer.bonusCookies) ? offer.bonusCookies : 0;
  return Math.max(0, base + bonus);
}

function purchaseDocRef(db, uid, purchaseToken) {
  const safeToken = String(purchaseToken || "").trim();
  // Store purchase record under users/{uid}/purchases/{purchaseToken}
  return db.doc(`users/${uid}/purchases/${safeToken}`);
}

// Best-effort auth: require a VERIFIED Firebase token for purchases.
async function requireVerifiedUid(req, res) {
  if (!_adminInitialized) {
    res.status(500).json({ error: "Admin SDK not initialized" });
    return null;
  }
  try {
    const decoded = await verifyIdTokenFromHeader(req);
    const uid = decoded && decoded.uid ? String(decoded.uid) : null;
    if (!uid) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    return { uid, decoded };
  } catch (e) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
}

// --- Economy identity: always per-uid (no deviceId fallback) ---
// Returns Firebase Auth uid (from ID token or x-user-id header), or null if not available.

// Verify token at most once per request (best-effort). Returns null if missing/invalid.
async function getVerifiedIdTokenCached(req) {
  try {
    if (req && req._verifiedIdTokenDecoded !== undefined) {
      return req._verifiedIdTokenDecoded; // may be null
    }
    if (!_adminInitialized) {
      req._verifiedIdTokenDecoded = null;
      return null;
    }
    const decoded = await verifyIdTokenFromHeader(req);
    req._verifiedIdTokenDecoded = decoded || null;
    return req._verifiedIdTokenDecoded;
  } catch {
    if (req) req._verifiedIdTokenDecoded = null;
    return null;
  }
}

// Returns { uid, decoded, hasVerifiedToken }
async function getEconomyAuthContext(req) {
  // 1) Best source: verified Firebase ID token (works for anonymous + logged-in)
  const decoded = await getVerifiedIdTokenCached(req);
  if (decoded && decoded.uid) {
    return { uid: String(decoded.uid), decoded, hasVerifiedToken: true };
  }

  // 2) Fallback for legacy/internal calls
  const headers = req.headers || {};
  const userIdHeader =
    (req.user && req.user.uid) ||
    headers["x-user-id"] ||
    headers["X-User-Id"] ||
    headers["x-userid"] ||
    null;

  return {
    uid: userIdHeader ? String(userIdHeader) : null,
    decoded: null,
    hasVerifiedToken: false,
  };
}

async function getEconomyUidFromRequest(req) {
  const ctx = await getEconomyAuthContext(req);
  return ctx.uid;
}

async function resolveLegacySyncUid(req) {
  const verified = await getVerifiedIdTokenCached(req);
  const bodyUid =
    typeof req.body?.uid === "string" && req.body.uid.trim()
      ? req.body.uid.trim()
      : null;

  if (verified?.uid) {
    const verifiedUid = String(verified.uid);
    if (bodyUid && bodyUid !== verifiedUid) {
      return {
        ok: false,
        status: 403,
        error: "uid_mismatch",
        uid: null,
        source: "verified_token",
      };
    }

    return {
      ok: true,
      uid: verifiedUid,
      source: "verified_token",
      fallbackUsed: false,
    };
  }

  if (bodyUid) {
    console.warn("[SyncAuth] Falling back to body uid for legacy sync endpoint", {
      path: req.path,
      uid: bodyUid,
    });
    return {
      ok: true,
      uid: bodyUid,
      source: "body_uid_fallback",
      fallbackUsed: true,
    };
  }

  return {
    ok: false,
    status: 401,
    error: "missing_uid",
    uid: null,
    source: "none",
  };
}

function stripUndefinedDeep(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => stripUndefinedDeep(item))
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = stripUndefinedDeep(child);
      if (normalized !== undefined) {
        out[key] = normalized;
      }
    }
    return out;
  }

  return value === undefined ? undefined : value;
}

function getEconomyDocRef(db, uid) {
  // Economy is always stored under users/{uid}/economy/default (per-uid only)
  return db.doc(`users/${uid}/economy/default`);
}

function getEconomyLedgerCol(db, uid) {
  return db.collection(`users/${uid}/economy/default/ledger`);
}

function normalizeEconomyData(raw = {}) {
  const cookies =
    typeof raw.cookies === "number" && Number.isFinite(raw.cookies)
      ? raw.cookies
      : 0;
  const freePremiumActionsRemaining =
    typeof raw.freePremiumActionsRemaining === "number" &&
    Number.isFinite(raw.freePremiumActionsRemaining)
      ? Math.max(0, Math.floor(raw.freePremiumActionsRemaining))
      : ECONOMY_LIMITS.FREE_PREMIUM_ACTIONS_STARTING;

  return {
    ...raw,
    cookies,
    freePremiumActionsRemaining,
    grants:
      raw.grants && typeof raw.grants === "object"
        ? raw.grants
        : {},
  };
}

function addEconomyLedgerEntryTx(tx, db, uid, entry = {}) {
  if (!uid) return;
  const createdAt =
    typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
      ? entry.createdAt
      : Date.now();
  const customId =
    typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : null;
  const ref = customId
    ? getEconomyLedgerCol(db, uid).doc(customId)
    : getEconomyLedgerCol(db, uid).doc();

  tx.set(
    ref,
    {
      uid,
      delta:
        typeof entry.delta === "number" && Number.isFinite(entry.delta)
          ? entry.delta
          : 0,
      balanceAfter:
        typeof entry.balanceAfter === "number" && Number.isFinite(entry.balanceAfter)
          ? entry.balanceAfter
          : null,
      freePremiumActionsAfter:
        typeof entry.freePremiumActionsAfter === "number" &&
        Number.isFinite(entry.freePremiumActionsAfter)
          ? entry.freePremiumActionsAfter
          : null,
      kind: typeof entry.kind === "string" ? entry.kind : "adjustment",
      reason: typeof entry.reason === "string" ? entry.reason : "unknown",
      actionKey:
        typeof entry.actionKey === "string" && entry.actionKey.trim()
          ? entry.actionKey.trim()
          : null,
      source:
        typeof entry.source === "string" && entry.source.trim()
          ? entry.source.trim()
          : null,
      metadata:
        entry.metadata && typeof entry.metadata === "object"
          ? entry.metadata
          : {},
      createdAt,
      _serverCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function getOrInitEconomyDocTx(tx, db, uid) {
  const ref = getEconomyDocRef(db, uid);
  const snap = await tx.get(ref);
  if (snap.exists) {
    const data = normalizeEconomyData(snap.data() || {});

    // Backfill economy contract markers for older docs (do NOT re-grant cookies).
    // This helps future-proof the economy without changing current balances.
    if (!data.grantVersion || typeof data.freePremiumActionsRemaining !== "number") {
      tx.set(
        ref,
        {
          grantVersion: "v1",
          freePremiumActionsRemaining: data.freePremiumActionsRemaining,
          // Preserve any existing grants object if it exists; otherwise initialize empty.
          grants: (data.grants && typeof data.grants === "object") ? data.grants : {},
          updatedAt: Date.now(),
          _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return { ref, data };
  }

  const now = Date.now();
  const initial = {
    cookies: ECONOMY_LIMITS.STARTING_COOKIES,
    freePremiumActionsRemaining: ECONOMY_LIMITS.FREE_PREMIUM_ACTIONS_STARTING,
    createdAt: now,
    updatedAt: now,

    // Economy contract markers (explicit grant record for first-time users)
    grantVersion: "v1",
    grants: {
      starting_v1: {
        amount: ECONOMY_LIMITS.STARTING_COOKIES,
        at: now,
      },
    },

    _serverCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
    _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  tx.set(ref, initial, { merge: true });
  addEconomyLedgerEntryTx(tx, db, uid, {
    id: "grant_starting_cookies_v1",
    delta: ECONOMY_LIMITS.STARTING_COOKIES,
    balanceAfter: ECONOMY_LIMITS.STARTING_COOKIES,
    freePremiumActionsAfter: ECONOMY_LIMITS.FREE_PREMIUM_ACTIONS_STARTING,
    kind: "grant",
    reason: "starting_cookies",
    source: "system",
    metadata: { grantKey: "starting_v1" },
    createdAt: now,
  });
  return { ref, data: initial };
}

// Grant signup bonus once, only when we have a VERIFIED token and the user is NOT anonymous.
// IMPORTANT: This must be called inside a Firestore transaction.

function isAnonymousProviderFromDecoded(decoded) {
  try {
    const p = decoded && decoded.firebase && decoded.firebase.sign_in_provider;
    return typeof p === "string" && p.toLowerCase() === "anonymous";
  } catch {
    return false;
  }
}

// Helper: Determine signup bonus status for catalog
function getSignupBonusStatus(economyData, authCtx) {
  const grants =
    economyData && economyData.grants && typeof economyData.grants === "object"
      ? economyData.grants
      : {};

  if (grants.signup_bonus_v1) {
    return { status: "redeemed", reason: "already_redeemed" };
  }

  // If we don't have a verified token, we cannot reliably know whether the session is anonymous.
  // Treat it as locked (login required) so the UI can prompt the user to sign in.
  if (!authCtx || !authCtx.hasVerifiedToken || !authCtx.decoded) {
    return { status: "locked", reason: "login_required" };
  }

  // Anonymous users can still see the offer as available (they just need to create an account).
  if (isAnonymousProviderFromDecoded(authCtx.decoded)) {
    return { status: "available", reason: "create_account_required" };
  }

  // Non-anonymous + verified token but no grant marker:
  // In normal flows, the bonus is auto-granted on first authenticated action/balance read.
  return { status: "available", reason: "eligible" };
}

function maybeGrantSignupBonusTx(tx, economyRef, economyData, decoded) {
  // Only grant when this request is authenticated (decoded token present)
  if (!decoded || !decoded.uid) {
    return {
      changed: false,
      cookies: economyData.cookies,
      freePremiumActionsRemaining: economyData.freePremiumActionsRemaining,
    };
  }

  // Do not grant for anonymous sessions
  if (isAnonymousProviderFromDecoded(decoded)) {
    return {
      changed: false,
      cookies: economyData.cookies,
      freePremiumActionsRemaining: economyData.freePremiumActionsRemaining,
    };
  }

  const grants = (economyData.grants && typeof economyData.grants === "object") ? economyData.grants : {};

  // Marker key for the one-time signup/login bonus
  if (grants.signup_bonus_v1) {
    return {
      changed: false,
      cookies: economyData.cookies,
      freePremiumActionsRemaining: economyData.freePremiumActionsRemaining,
    };
  }

  const now = Date.now();
  const bonus = ECONOMY_LIMITS.SIGNUP_BONUS_COOKIES;
  const nextCookies = (typeof economyData.cookies === "number" && Number.isFinite(economyData.cookies) ? economyData.cookies : 0) + bonus;

  tx.set(
    economyRef,
    {
      cookies: nextCookies,
      updatedAt: now,
      _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      grants: {
        ...grants,
        signup_bonus_v1: {
          amount: bonus,
          at: now,
        },
      },
      lastGrant: {
        amount: bonus,
        reason: "signup_bonus",
        at: now,
      },
    },
    { merge: true }
  );

  return {
    changed: true,
    cookies: nextCookies,
    freePremiumActionsRemaining: economyData.freePremiumActionsRemaining,
    ledger: {
      id: "grant_signup_bonus_v1",
      delta: bonus,
      balanceAfter: nextCookies,
      freePremiumActionsAfter: economyData.freePremiumActionsRemaining,
      kind: "grant",
      reason: "signup_bonus",
      source: "system",
      metadata: { grantKey: "signup_bonus_v1" },
      createdAt: now,
    },
  };
}

function getRewardBonusStatus(economyData, rewardKey) {
  const def = ECONOMY_REWARD_DEFS[rewardKey];
  const grants =
    economyData && economyData.grants && typeof economyData.grants === "object"
      ? economyData.grants
      : {};

  if (grants[rewardKey]) {
    return { status: "redeemed", reason: "already_redeemed" };
  }

  const prerequisiteRewardKey =
    def && typeof def.prerequisiteRewardKey === "string" && def.prerequisiteRewardKey.trim()
      ? def.prerequisiteRewardKey.trim()
      : null;

  if (prerequisiteRewardKey && !grants[prerequisiteRewardKey]) {
    return { status: "hidden", reason: "prerequisite_incomplete" };
  }

  return { status: "available", reason: "eligible" };
}

function claimEconomyRewardTx(tx, db, uid, economyRef, economyData, rewardKey) {
  const def = ECONOMY_REWARD_DEFS[rewardKey];
  if (!def || !uid) {
    return {
      changed: false,
      cookies: economyData.cookies,
      freePremiumActionsRemaining: economyData.freePremiumActionsRemaining,
    };
  }

  const grants =
    economyData && economyData.grants && typeof economyData.grants === "object"
      ? economyData.grants
      : {};

  if (grants[rewardKey]) {
    return {
      changed: false,
      cookies: economyData.cookies,
      freePremiumActionsRemaining: economyData.freePremiumActionsRemaining,
      alreadyGranted: true,
    };
  }

  const now = Date.now();
  const amount = typeof def.amount === "number" && Number.isFinite(def.amount) ? def.amount : 0;
  const currentCookies =
    typeof economyData.cookies === "number" && Number.isFinite(economyData.cookies)
      ? economyData.cookies
      : 0;
  const nextCookies = currentCookies + amount;

  tx.set(
    economyRef,
    {
      cookies: nextCookies,
      updatedAt: now,
      _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      grants: {
        ...grants,
        [rewardKey]: {
          amount,
          at: now,
        },
      },
      lastGrant: {
        amount,
        reason: def.reason,
        at: now,
      },
    },
    { merge: true }
  );

  addEconomyLedgerEntryTx(tx, db, uid, {
    id: `grant_${rewardKey}`,
    delta: amount,
    balanceAfter: nextCookies,
    freePremiumActionsAfter: economyData.freePremiumActionsRemaining,
    kind: "grant",
    reason: def.reason,
    source: "system",
    metadata: { grantKey: rewardKey },
    createdAt: now,
  });

  return {
    changed: true,
    cookies: nextCookies,
    freePremiumActionsRemaining: economyData.freePremiumActionsRemaining,
    rewardKey,
    reason: def.reason,
    amount,
  };
}

async function consumePremiumAction({ req, amount, reason, allowFreePremiumActions = true }) {
  // Fail open if economy disabled or Firestore/Admin unavailable.
  if (!ECONOMY_ENABLED) {
    return {
      ok: true,
      skipped: true,
      source: null,
      charged: 0,
      remaining: null,
      remainingFreePremiumActions: null,
    };
  }
  if (!_adminInitialized) {
    console.warn("[Economy] Admin SDK not initialized; skipping egg enforcement");
    return {
      ok: true,
      skipped: true,
      source: null,
      charged: 0,
      remaining: null,
      remainingFreePremiumActions: null,
    };
  }

  const authCtx = await getEconomyAuthContext(req);
  const uid = authCtx.uid;
  if (!uid) {
    // Option A requires uid. If missing, fail open (MVP) to avoid breaking flows.
    console.warn("[Economy] Missing uid (Authorization Bearer token or x-user-id); skipping egg enforcement");
    return {
      ok: true,
      skipped: true,
      source: null,
      charged: 0,
      remaining: null,
      remainingFreePremiumActions: null,
    };
  }

  const amt = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  if (amt <= 0) {
    return {
      ok: true,
      skipped: true,
      source: null,
      charged: 0,
      remaining: null,
      remainingFreePremiumActions: null,
    };
  }

  const db = getAnalyticsDb();

  try {
    const result = await db.runTransaction(async (tx) => {
      const { ref, data } = await getOrInitEconomyDocTx(tx, db, uid);
      // One-time signup bonus: only when we have a VERIFIED non-anonymous token.
      // This runs before spend checks so the first post-signup action can benefit from the bonus.
      const grantRes = maybeGrantSignupBonusTx(tx, ref, data, authCtx.decoded);
      if (grantRes?.ledger) {
        addEconomyLedgerEntryTx(tx, db, uid, grantRes.ledger);
      }

      // Use the possibly-updated cookie balance for spend validation.
      const effectiveCookies =
        typeof grantRes.cookies === "number" && Number.isFinite(grantRes.cookies)
          ? grantRes.cookies
          : (typeof data.cookies === "number" && Number.isFinite(data.cookies) ? data.cookies : 0);
      const effectiveFreePremiumActions =
        typeof grantRes.freePremiumActionsRemaining === "number" &&
        Number.isFinite(grantRes.freePremiumActionsRemaining)
          ? Math.max(0, Math.floor(grantRes.freePremiumActionsRemaining))
          : typeof data.freePremiumActionsRemaining === "number" &&
              Number.isFinite(data.freePremiumActionsRemaining)
            ? Math.max(0, Math.floor(data.freePremiumActionsRemaining))
            : 0;

      const current = effectiveCookies;
      const currentFree = effectiveFreePremiumActions;

      if (allowFreePremiumActions && currentFree > 0) {
        const now = Date.now();
        const nextFree = currentFree - 1;

        tx.set(
          ref,
          {
            freePremiumActionsRemaining: nextFree,
            updatedAt: now,
            _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastSpend: {
              amount: 1,
              reason: reason || "unknown",
              source: "free_premium_action",
              at: now,
            },
          },
          { merge: true }
        );

        return {
          ok: true,
          source: "free_premium_action",
          charged: 0,
          remaining: current,
          remainingFreePremiumActions: nextFree,
          uid,
        };
      }

      if (current < amt) {
        return {
          ok: false,
          code: ECONOMY_ERROR_CODES.NOT_ENOUGH_COOKIES,
          action: reason || "unknown",
          requiredCookies: amt,
          remaining: current,
          remainingFreePremiumActions: currentFree,
          uid,
        };
      }

      const now = Date.now();
      const next = current - amt;

      tx.set(
        ref,
        {
          cookies: next,
          updatedAt: now,
          _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          // Minimal audit trail (MVP). No ledger yet.
          lastSpend: {
            amount: amt,
            reason: reason || "unknown",
            source: "cookies",
            at: now,
          },
        },
        { merge: true }
      );
      addEconomyLedgerEntryTx(tx, db, uid, {
        delta: -amt,
        balanceAfter: next,
        freePremiumActionsAfter: currentFree,
        kind: "spend",
        reason: reason || "unknown",
        actionKey: reason || "unknown",
        source: "cookies",
        createdAt: now,
      });

      return {
        ok: true,
        source: "cookies",
        charged: amt,
        remaining: next,
        remainingFreePremiumActions: currentFree,
        uid,
      };
    });

    return result;
  } catch (err) {
    // Fail open to avoid breaking recipe generation due to transient DB issues.
    console.error("[Economy] spendCookies transaction failed; skipping enforcement", {
      message: err?.message,
      code: err?.code,
    });
    return { ok: true, skipped: true, remaining: null };
  }
}

async function previewPremiumAction({ req, amount, reason, allowFreePremiumActions = true }) {
  if (!ECONOMY_ENABLED) {
    return {
      ok: true,
      skipped: true,
      allowed: true,
      source: null,
      remaining: null,
      remainingFreePremiumActions: null,
      action: reason || "unknown",
      requiredCookies: typeof amount === "number" && Number.isFinite(amount) ? amount : 0,
    };
  }
  if (!_adminInitialized) {
    return {
      ok: true,
      skipped: true,
      allowed: true,
      source: null,
      remaining: null,
      remainingFreePremiumActions: null,
      action: reason || "unknown",
      requiredCookies: typeof amount === "number" && Number.isFinite(amount) ? amount : 0,
    };
  }

  const authCtx = await getEconomyAuthContext(req);
  const uid = authCtx.uid;
  if (!uid) {
    return {
      ok: true,
      skipped: true,
      allowed: true,
      source: null,
      remaining: null,
      remainingFreePremiumActions: null,
      action: reason || "unknown",
      requiredCookies: typeof amount === "number" && Number.isFinite(amount) ? amount : 0,
    };
  }

  const amt = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  if (amt <= 0) {
    return {
      ok: true,
      skipped: true,
      allowed: true,
      source: null,
      remaining: null,
      remainingFreePremiumActions: null,
      action: reason || "unknown",
      requiredCookies: 0,
    };
  }

  const db = getAnalyticsDb();
  try {
    const result = await db.runTransaction(async (tx) => {
      const { ref, data } = await getOrInitEconomyDocTx(tx, db, uid);
      const grantRes = maybeGrantSignupBonusTx(tx, ref, data, authCtx.decoded);
      if (grantRes?.ledger) {
        addEconomyLedgerEntryTx(tx, db, uid, grantRes.ledger);
      }

      const effectiveCookies =
        typeof grantRes.cookies === "number" && Number.isFinite(grantRes.cookies)
          ? grantRes.cookies
          : (typeof data.cookies === "number" && Number.isFinite(data.cookies) ? data.cookies : 0);
      const effectiveFreePremiumActions =
        typeof grantRes.freePremiumActionsRemaining === "number" &&
        Number.isFinite(grantRes.freePremiumActionsRemaining)
          ? Math.max(0, Math.floor(grantRes.freePremiumActionsRemaining))
          : typeof data.freePremiumActionsRemaining === "number" &&
              Number.isFinite(data.freePremiumActionsRemaining)
            ? Math.max(0, Math.floor(data.freePremiumActionsRemaining))
            : 0;

      if (allowFreePremiumActions && effectiveFreePremiumActions > 0) {
        return {
          ok: true,
          allowed: true,
          source: "free_premium_action",
          remaining: effectiveCookies,
          remainingFreePremiumActions: effectiveFreePremiumActions,
          action: reason || "unknown",
          requiredCookies: amt,
          uid,
        };
      }

      if (effectiveCookies < amt) {
        return {
          ok: false,
          allowed: false,
          code: ECONOMY_ERROR_CODES.NOT_ENOUGH_COOKIES,
          source: "cookies",
          action: reason || "unknown",
          requiredCookies: amt,
          remaining: effectiveCookies,
          remainingFreePremiumActions: effectiveFreePremiumActions,
          uid,
        };
      }

      return {
        ok: true,
        allowed: true,
        source: "cookies",
        remaining: effectiveCookies,
        remainingFreePremiumActions: effectiveFreePremiumActions,
        action: reason || "unknown",
        requiredCookies: amt,
        uid,
      };
    });

    return result;
  } catch (err) {
    console.error("[Economy] previewPremiumAction failed; skipping enforcement", {
      message: err?.message,
      code: err?.code,
    });
    return {
      ok: true,
      skipped: true,
      allowed: true,
      source: null,
      remaining: null,
      remainingFreePremiumActions: null,
      action: reason || "unknown",
      requiredCookies: amt,
    };
  }
}

async function spendCookies({ req, amount, reason }) {
  return consumePremiumAction({
    req,
    amount,
    reason,
    allowFreePremiumActions: true,
  });
}

// Read (and lazily initialize) the user's economy doc.
// This is used by the Profile "Cookies" UI so that a brand-new user
// immediately sees the free starting cookies without needing to spend first.
async function getOrInitCookiesBalance(req) {
  // If economy is disabled, still return the starting cookies so the UI works.
  if (!ECONOMY_ENABLED) {
    return { ok: true, skipped: true, cookies: ECONOMY_LIMITS.STARTING_COOKIES };
  }

  if (!_adminInitialized) {
    console.warn("[Economy] Admin SDK not initialized; returning default starting cookies");
    return { ok: true, skipped: true, cookies: ECONOMY_LIMITS.STARTING_COOKIES };
  }

  const authCtx = await getEconomyAuthContext(req);
  const uid = authCtx.uid;
  if (!uid) {
    console.warn("[Economy] Missing uid (Authorization Bearer token or x-user-id); returning default starting cookies");
    return { ok: true, skipped: true, cookies: ECONOMY_LIMITS.STARTING_COOKIES };
  }

  const db = getAnalyticsDb();

  try {
    const result = await db.runTransaction(async (tx) => {
      const { ref, data } = await getOrInitEconomyDocTx(tx, db, uid);
      // One-time signup bonus: only when we have a VERIFIED non-anonymous token.
      const grantRes = maybeGrantSignupBonusTx(tx, ref, data, authCtx.decoded);
      if (grantRes?.ledger) {
        addEconomyLedgerEntryTx(tx, db, uid, grantRes.ledger);
      }

      const effectiveCookies =
        typeof grantRes.cookies === "number" && Number.isFinite(grantRes.cookies)
          ? grantRes.cookies
          : (typeof data.cookies === "number" && Number.isFinite(data.cookies) ? data.cookies : 0);

      const current = effectiveCookies;

      // Defensive: if doc exists but cookies is missing, persist a normalized value.
      if (
        typeof data.cookies !== "number" ||
        !Number.isFinite(data.cookies) ||
        typeof data.freePremiumActionsRemaining !== "number" ||
        !Number.isFinite(data.freePremiumActionsRemaining)
      ) {
        tx.set(
          ref,
          {
            cookies: current,
            freePremiumActionsRemaining:
              typeof data.freePremiumActionsRemaining === "number" &&
              Number.isFinite(data.freePremiumActionsRemaining)
                ? Math.max(0, Math.floor(data.freePremiumActionsRemaining))
                : ECONOMY_LIMITS.FREE_PREMIUM_ACTIONS_STARTING,
            updatedAt: Date.now(),
            _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      return {
        ok: true,
        cookies: current,
        freePremiumActionsRemaining:
          typeof data.freePremiumActionsRemaining === "number" &&
          Number.isFinite(data.freePremiumActionsRemaining)
            ? Math.max(0, Math.floor(data.freePremiumActionsRemaining))
            : ECONOMY_LIMITS.FREE_PREMIUM_ACTIONS_STARTING,
        uid,
      };
    });

    return result;
  } catch (err) {
    // Fail open: do not break the Profile screen if Firestore is temporarily unavailable.
    console.error("[Economy] getOrInitCookiesBalance failed; returning default starting cookies", {
      message: err?.message,
      code: err?.code,
    });
    return {
      ok: true,
      skipped: true,
      cookies: ECONOMY_LIMITS.STARTING_COOKIES,
      freePremiumActionsRemaining: ECONOMY_LIMITS.FREE_PREMIUM_ACTIONS_STARTING,
    };
  }
}

// --- Economy endpoints (Cookies balance) ---
// The app calls this to render the Cookies area in Profile.
// It returns BOTH `cookies` and `balance` for compatibility.
app.get("/economy/balance", async (req, res) => {
  try {
    const result = await getOrInitCookiesBalance(req);
    const cookies =
      typeof result.cookies === "number" && Number.isFinite(result.cookies)
        ? result.cookies
        : ECONOMY_LIMITS.STARTING_COOKIES;

    return res.json({
      ok: true,
      cookies,
      balance: cookies,
      freePremiumActionsRemaining:
        typeof result.freePremiumActionsRemaining === "number"
          ? result.freePremiumActionsRemaining
          : ECONOMY_LIMITS.FREE_PREMIUM_ACTIONS_STARTING,
      skipped: !!result.skipped,
    });
  } catch (err) {
    console.error("❌ /economy/balance (GET) error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load Eggs balance" });
  }
});

app.post("/economy/balance", async (req, res) => {
  try {
    // Support legacy clients that pass uid or userId in body by mapping to x-user-id.
    // This does NOT replace proper auth; it's just a compatibility fallback.
    const body = req.body || {};
    const bodyUid =
      (body && typeof body.uid === "string" && body.uid.trim())
        ? body.uid.trim()
        : (body && typeof body.userId === "string" && body.userId.trim())
        ? body.userId.trim()
        : null;

    if (bodyUid) {
      req.headers["x-user-id"] = bodyUid;
    }

    const result = await getOrInitCookiesBalance(req);
    const cookies =
      typeof result.cookies === "number" && Number.isFinite(result.cookies)
        ? result.cookies
        : ECONOMY_LIMITS.STARTING_COOKIES;

    return res.json({
      ok: true,
      cookies,
      balance: cookies,
      freePremiumActionsRemaining:
        typeof result.freePremiumActionsRemaining === "number"
          ? result.freePremiumActionsRemaining
          : ECONOMY_LIMITS.FREE_PREMIUM_ACTIONS_STARTING,
      skipped: !!result.skipped,
    });
  } catch (err) {
    console.error("❌ /economy/balance (POST) error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load Eggs balance" });
  }
});

app.get("/economy/history", async (req, res) => {
  try {
    if (!ECONOMY_ENABLED || !_adminInitialized) {
      return res.json({ ok: true, entries: [] });
    }

    const authCtx = await getEconomyAuthContext(req);
    const uid = authCtx.uid;
    if (!uid) {
      return res.json({ ok: true, entries: [] });
    }

    const limitRaw =
      typeof req.query?.limit === "string" ? Number(req.query.limit) : 50;
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(100, Math.floor(limitRaw))
        : 50;

    const db = getAnalyticsDb();
    const snap = await getEconomyLedgerCol(db, uid)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const entries = snap.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() || {}),
    }));

    return res.json({ ok: true, entries });
  } catch (err) {
    console.error("❌ /economy/history error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Failed to load Eggs history" });
  }
});

app.post("/economy/rewards/claim", async (req, res) => {
  try {
    if (!ECONOMY_ENABLED || !_adminInitialized) {
      return res.json({ ok: true, skipped: true });
    }

    const rewardKey =
      typeof req.body?.rewardKey === "string" && req.body.rewardKey.trim()
        ? req.body.rewardKey.trim()
        : null;

    if (!rewardKey || !ECONOMY_REWARD_DEFS[rewardKey]) {
      return res.status(400).json({ ok: false, error: "invalid_reward_key" });
    }

    const authCtx = await getEconomyAuthContext(req);
    const uid = authCtx.uid;
    if (!uid) {
      return res.status(401).json({ ok: false, error: "missing_uid" });
    }

    const db = getAnalyticsDb();
    const result = await db.runTransaction(async (tx) => {
      const { ref, data } = await getOrInitEconomyDocTx(tx, db, uid);
      const grantRes = maybeGrantSignupBonusTx(tx, ref, data, authCtx.decoded);
      const effectiveData = {
        ...data,
        cookies:
          typeof grantRes.cookies === "number" && Number.isFinite(grantRes.cookies)
            ? grantRes.cookies
            : data.cookies,
        freePremiumActionsRemaining:
          typeof grantRes.freePremiumActionsRemaining === "number" &&
          Number.isFinite(grantRes.freePremiumActionsRemaining)
            ? grantRes.freePremiumActionsRemaining
            : data.freePremiumActionsRemaining,
      };
      if (grantRes?.ledger) {
        addEconomyLedgerEntryTx(tx, db, uid, grantRes.ledger);
      }

      const rewardRes = claimEconomyRewardTx(tx, db, uid, ref, effectiveData, rewardKey);
      return {
        ok: true,
        changed: !!rewardRes.changed,
        alreadyGranted: !!rewardRes.alreadyGranted,
        rewardKey,
        cookies:
          typeof rewardRes.cookies === "number" && Number.isFinite(rewardRes.cookies)
            ? rewardRes.cookies
            : effectiveData.cookies,
        freePremiumActionsRemaining:
          typeof rewardRes.freePremiumActionsRemaining === "number" &&
          Number.isFinite(rewardRes.freePremiumActionsRemaining)
            ? rewardRes.freePremiumActionsRemaining
            : effectiveData.freePremiumActionsRemaining,
      };
    });

    return res.json(result);
  } catch (err) {
    console.error("❌ /economy/rewards/claim error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "failed_to_claim_reward" });
  }
});

app.post("/economy/premium-action", async (req, res) => {
  try {
    const action =
      typeof req.body?.action === "string" ? req.body.action.trim() : "";
    const previewOnly = req.body?.preview === true;
    const amount = PREMIUM_ACTION_COSTS[action];

    if (!action || typeof amount !== "number" || !Number.isFinite(amount)) {
      return res.status(400).json({ ok: false, error: "Unknown premium action" });
    }

    const economySpend = previewOnly
      ? await previewPremiumAction({ req, amount, reason: action })
      : await spendCookies({ req, amount, reason: action });

    if (economySpend && economySpend.ok === false) {
      return respondNotEnoughCookies(res, {
        action,
        requiredCookies: economySpend.requiredCookies || amount,
        balance: economySpend.remaining,
        remainingFreePremiumActions: economySpend.remainingFreePremiumActions,
        message: `You need ${amount} Eggs to use this premium action.`,
      });
    }

    return res.json({
      ok: true,
      action,
      preview: previewOnly,
      source: economySpend?.source || null,
      charged:
        typeof economySpend?.charged === "number" ? economySpend.charged : 0,
      remaining:
        typeof economySpend?.remaining === "number" ? economySpend.remaining : null,
      remainingFreePremiumActions:
        typeof economySpend?.remainingFreePremiumActions === "number"
          ? economySpend.remainingFreePremiumActions
          : null,
      skippedEconomy: !!economySpend?.skipped,
    });
  } catch (err) {
    console.error("❌ /economy/premium-action error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Failed to process premium action" });
  }
});
// Backend-first economy contract/config endpoint.
// The mobile app can call this to fetch current pricing, limits and any active offers.
app.get("/economy/config", async (req, res) => {
  try {
    const bal = await getOrInitCookiesBalance(req);
    const cookies =
      typeof bal.cookies === "number" && Number.isFinite(bal.cookies)
        ? bal.cookies
        : ECONOMY_LIMITS.STARTING_COOKIES;
    const freePremiumActionsRemaining =
      typeof bal.freePremiumActionsRemaining === "number" &&
      Number.isFinite(bal.freePremiumActionsRemaining)
        ? Math.max(0, Math.floor(bal.freePremiumActionsRemaining))
        : ECONOMY_LIMITS.FREE_PREMIUM_ACTIONS_STARTING;

    return res.json({
      ok: true,
      version: "v1",
      startingFreePremiumActions: ECONOMY_LIMITS.FREE_PREMIUM_ACTIONS_STARTING,
      startingCookies: ECONOMY_LIMITS.STARTING_COOKIES,
      signupBonusCookies: ECONOMY_LIMITS.SIGNUP_BONUS_COOKIES,
      costs: {
        aiSuggestions: ECONOMY_LIMITS.COST_AI_RECIPE_SUGGESTIONS,
        aiFullRecipe: ECONOMY_LIMITS.COST_AI_RECIPE_FULL,
        instagramReelImport: ECONOMY_LIMITS.COST_IMPORT_INSTAGRAM_REEL,
        recipeNutritionEstimate: ECONOMY_LIMITS.COST_RECIPE_NUTRITION_ESTIMATE,
        mealPhotoLog: ECONOMY_LIMITS.COST_MEAL_PHOTO_LOG,
        describeMeal: ECONOMY_LIMITS.COST_DESCRIBE_MEAL,
        createCookbook: 0,
      },
      freeRules: {
        freeCustomCookbooks: null,
        defaultCookbooksFree: true,
      },
      offers: ECONOMY_OFFERS,
      balance: {
        cookies,
        freePremiumActionsRemaining,
      },
    });
  } catch (err) {
    console.error("❌ /economy/config (GET) error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load economy config" });
  }
});

app.post("/recipes/estimate-nutrition/charge", async (req, res) => {
  try {
    const previewOnly = req.body?.preview === true;
    const economySpend = previewOnly
      ? await previewPremiumAction({
          req,
          amount: ECONOMY_LIMITS.COST_RECIPE_NUTRITION_ESTIMATE,
          reason: "recipe_nutrition_estimate",
        })
      : await spendCookies({
      req,
      amount: ECONOMY_LIMITS.COST_RECIPE_NUTRITION_ESTIMATE,
      reason: "recipe_nutrition_estimate",
    });

    if (economySpend && economySpend.ok === false) {
      return respondNotEnoughCookies(res, {
        action: economySpend.action || "recipe_nutrition_estimate",
        requiredCookies:
          economySpend.requiredCookies || ECONOMY_LIMITS.COST_RECIPE_NUTRITION_ESTIMATE,
        balance: economySpend.remaining,
        remainingFreePremiumActions: economySpend.remainingFreePremiumActions,
        message: `You need ${ECONOMY_LIMITS.COST_RECIPE_NUTRITION_ESTIMATE} Eggs to estimate recipe nutrition values.`,
      });
    }

    return res.json({
      ok: true,
      action: "recipe_nutrition_estimate",
      preview: previewOnly,
      source: economySpend?.source || null,
      charged:
        typeof economySpend?.charged === "number" ? economySpend.charged : 0,
      remaining:
        typeof economySpend?.remaining === "number" ? economySpend.remaining : null,
      remainingFreePremiumActions:
        typeof economySpend?.remainingFreePremiumActions === "number"
          ? economySpend.remainingFreePremiumActions
          : null,
      skippedEconomy: !!economySpend?.skipped,
    });
  } catch (err) {
    console.error("❌ /recipes/estimate-nutrition/charge error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Failed to charge nutrition estimate" });
  }
});

app.post("/recipes/estimate-nutrition", async (req, res) => {
  try {
    const title = sanitizeInput(req.body?.title || "Recipe");
    const language = normalizeLanguage(req.body?.language);
    const servingsRaw = Number(req.body?.servings);
    const servings = Number.isFinite(servingsRaw) && servingsRaw > 0 ? Math.round(servingsRaw) : null;
    const ingredients = Array.isArray(req.body?.ingredients)
      ? req.body.ingredients.map(sanitizeInput).filter(Boolean).slice(0, 80)
      : [];

    if (!title && ingredients.length === 0) {
      return res.status(400).json({ ok: false, error: "Recipe title or ingredients are required" });
    }

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["perServing", "servingsUsed", "yieldUnit", "recipeType", "confidence"],
      properties: {
        perServing: {
          type: "object",
          additionalProperties: false,
          required: ["calories", "protein", "carbs", "fat"],
          properties: {
            calories: { type: "number" },
            protein: { type: "number" },
            carbs: { type: "number" },
            fat: { type: "number" },
          },
        },
        servingsUsed: { type: "number" },
        yieldUnit: { type: "string" },
        recipeType: { type: "string" },
        confidence: { type: "number" },
      },
    };

    const prompt = `
Estimate nutrition per serving for this recipe as a whole.

Rules:
- Use the full recipe context, not ingredient-by-ingredient serving guesses.
- If recipe servings are provided, use them only when they appear to mean expected eating portions.
- If the provided serving count is 1 but the recipe is clearly a batch, tray, cake, bars, cookies, dip, spread, sauce, waffles, pancakes, or snack made from multi-serving quantities, infer the number of expected eating servings instead of treating the whole batch as one serving.
- If servings are not specified, infer a typical yield/number of portions from the dish type, title, ingredient quantities, and recipe context.
- For tray cakes, bars, cookies, pancakes, waffles, pies, quiches, or batch desserts, avoid treating the whole batch as one serving unless the title clearly says single serving.
- servingsUsed is the number of expected eating servings a person would log, not necessarily the physical number of pieces.
- yieldUnit should describe what the recipe makes, e.g. portions, slices, bars, cookies, pancakes, waffles, cups.
- recipeType should be a short category, e.g. main_dish, side_dish, dessert, snack, breakfast, batch_bake, drink.
- Return conservative, realistic per-serving calories and macros.
- Do not explain.

Recipe:
Title: ${title || "Recipe"}
Servings: ${servings ?? "not specified; infer realistic yield"}
Language: ${language}
Ingredients:
${ingredients.map((ingredient) => `- ${ingredient}`).join("\n") || "- Not provided"}
`;

    let raw = await requestStructuredJsonCompletion({
      schemaName: "recipe_nutrition_estimate",
      schema,
      temperature: 0.1,
      timeoutMs: 20000,
      messages: [
        {
          role: "system",
          content:
            "You are a nutrition estimation assistant. Estimate the whole recipe per serving with realistic conservative calories and macros. Return valid JSON only.",
        },
        { role: "user", content: prompt },
      ],
    });

    raw = cleanJsonResponse(raw);
    const parsed = safeJSONParse(raw, {});
    const perServing = parsed?.perServing || {};
    const nutrition = {
      calories: Math.max(Math.round(Number(perServing.calories) || 0), 1),
      protein: Math.max(Math.round(Number(perServing.protein) || 0), 0),
      carbs: Math.max(Math.round(Number(perServing.carbs) || 0), 0),
      fat: Math.max(Math.round(Number(perServing.fat) || 0), 0),
    };

    if (!Number.isFinite(nutrition.calories) || nutrition.calories <= 0) {
      return res.status(500).json({ ok: false, error: "Failed to estimate recipe nutrition" });
    }

    return res.json({
      ok: true,
      nutrition: {
        perServing: nutrition,
        source: "ai_recipe_estimate",
        updatedAt: new Date().toISOString(),
      },
      servingsUsed: Number.isFinite(Number(parsed?.servingsUsed)) ? Number(parsed.servingsUsed) : servings,
      yieldUnit: sanitizeInput(parsed?.yieldUnit || ""),
      recipeType: sanitizeInput(parsed?.recipeType || ""),
      confidence: Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : null,
    });
  } catch (err) {
    console.error("❌ /recipes/estimate-nutrition error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Failed to estimate recipe nutrition" });
  }
});

// Backend-first economy catalog for the in-app store UI.
// The mobile app should render offers and only allow purchase if billingEnabled is true.
app.get("/economy/catalog", async (req, res) => {
  try {
    // Balance is computed the same way as /economy/balance (including lazy init)
    const bal = await getOrInitCookiesBalance(req);
    const cookies =
      typeof bal.cookies === "number" && Number.isFinite(bal.cookies)
        ? bal.cookies
        : ECONOMY_LIMITS.STARTING_COOKIES;

    // --- Signup bonus status and bonuses card logic ---
    const authCtx = await getEconomyAuthContext(req);

    // Best-effort load of economy doc to determine whether signup bonus has already been granted.
    let economyDataForStatus = null;
    if (ECONOMY_ENABLED && _adminInitialized) {
      try {
        const uidForStatus = authCtx && authCtx.uid ? String(authCtx.uid) : null;
        if (uidForStatus) {
          const db2 = getAnalyticsDb();
          const ref2 = getEconomyDocRef(db2, uidForStatus);
          const snap2 = await ref2.get();
          economyDataForStatus = snap2.exists ? (snap2.data() || null) : null;
        }
      } catch {
        economyDataForStatus = null;
      }
    }

    const signupBonus = getSignupBonusStatus(economyDataForStatus, authCtx);

    const rewardBonuses = Object.entries(ECONOMY_REWARD_DEFS)
      .map(([rewardKey, def]) => {
        const status = getRewardBonusStatus(economyDataForStatus, rewardKey);
        return {
          id: def.bonusId,
          rewardKey,
          kind: "reward",
          title: def.title,
          description: def.description,
          price: 0,
          currency: "USD",
          cookies: def.amount,
          status: status.status,
          reason: status.reason,
          action: def.action || null,
          badges: Array.isArray(def.badges) ? def.badges : [],
          sortOrder:
            typeof def.sortOrder === "number" && Number.isFinite(def.sortOrder)
              ? def.sortOrder
              : 0,
        };
      })
      .filter((reward) => reward.status !== "hidden")
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    // "Free offer" shown in the catalog (no redeem button). It becomes redeemed automatically once granted.
    const bonuses = [
      {
        id: "signup_bonus_v1",
        rewardKey: "signup_bonus_v1",
        kind: "signup_bonus",
        title: `Create an account bonus`,
        description: "Create an account and log in.",
        price: 0,
        currency: "USD",
        cookies: ECONOMY_LIMITS.SIGNUP_BONUS_COOKIES,
        status: signupBonus.status, // available | redeemed | locked
        reason: signupBonus.reason, // create_account_required | already_redeemed | login_required | eligible
        action:
          signupBonus.status === "available" && signupBonus.reason === "create_account_required"
            ? "create_account"
            : null,
        badges: ["🎁 Welcome bonus"],
      },
      ...rewardBonuses,
    ];

    // Offer rendering should be deterministic
    const offers = [...ECONOMY_OFFERS]
      .map((o) => {
        const sku = o.sku || o.id;
        const productId = o.productId || sku;
        const bonusCookies =
          typeof o.bonusCookies === "number" && Number.isFinite(o.bonusCookies)
            ? o.bonusCookies
            : 0;
        const baseCookies =
          typeof o.cookies === "number" && Number.isFinite(o.cookies)
            ? o.cookies
            : 0;
        const totalCookies = Math.max(0, baseCookies + bonusCookies);

        return {
          id: o.id,
          productId,
          sku,
          title: o.title,
          subtitle: o.subtitle || null,
          cookies: totalCookies,
          // Keep base/bonus so the UI can show “+10 bonus” later if you want
          baseCookies,
          bonusCookies,
          price: o.price,
          currency: o.currency,
          badges: Array.isArray(o.badges) ? o.badges : [],
          isPromo: !!o.isPromo,
          sortOrder:
            typeof o.sortOrder === "number" && Number.isFinite(o.sortOrder)
              ? o.sortOrder
              : 0,
          mostPurchased: !!o.mostPurchased,
        };
      })
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    // Choose a single currency for the catalog (fallback to first offer)
    const catalogCurrency =
      (offers[0] && offers[0].currency) ||
      (ECONOMY_OFFERS[0] && ECONOMY_OFFERS[0].currency) ||
      "USD";

    return res.json({
      ok: true,
      version: "v1",
      platform: "android",
      billingEnabled: !!ECONOMY_BILLING_ENABLED,

      // New, stable shape (preferred by the app)
      balance: { cookies },
      catalog: {
        currency: catalogCurrency,
        offers,
        bonuses,
      },

      // Keep backend-controlled messaging
      promo: {
        message: ECONOMY_BILLING_ENABLED ? null : "Purchases coming soon.",
      },

      // Backward-compat fields (so older clients don’t break)
      cookies,
      offersLegacy: offers,
      bonuses,
    });
  } catch (err) {
    console.error("❌ /economy/catalog (GET) error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load economy catalog" });
  }
});

// Verify a Google Play purchase and grant cookies.
// IMPORTANT: This endpoint is designed to be enabled later.
// For now, it returns a stable error when billing is disabled.
//
// Body:
//  {
//    "sku": "cookies_50",
//    "purchaseToken": "...",
//    "orderId": "..." (optional),
//    "packageName": "..." (optional)
//  }
//
// NOTE: The mobile client may call either:
//  - POST /economy/purchases/verify   (canonical)
//  - POST /economy/verify-play        (legacy/alias)
// Both routes share the same implementation.
async function handleEconomyPurchaseVerify(req, res) {
  try {
    if (!ECONOMY_BILLING_ENABLED) {
      return res.status(409).json({
        ok: false,
        code: "BILLING_DISABLED",
        message: "In-app purchases are not enabled yet.",
      });
    }

    if (ECONOMY_BILLING_ENABLED && !isPlayVerifierConfigured()) {
      console.warn("[Economy] Billing enabled but Play verifier not configured. Check ANDROID_PACKAGE_NAME and service account envs.");
    }

    const auth = await requireVerifiedUid(req, res);
    if (!auth) return;

    const body = req.body || {};

    // Accept a couple of common field aliases just in case different clients send different names.
    const sku =
      (typeof body.productId === "string" && body.productId.trim())
        ? body.productId.trim()
        : (typeof body.sku === "string" && body.sku.trim())
        ? body.sku.trim()
        : (typeof body.offerId === "string" && body.offerId.trim())
        ? body.offerId.trim()
        : "";

    const purchaseToken =
      (typeof body.purchaseToken === "string" && body.purchaseToken.trim())
        ? body.purchaseToken.trim()
        : (typeof body.token === "string" && body.token.trim())
        ? body.token.trim()
        : "";

    const orderId = typeof body.orderId === "string" ? body.orderId.trim() : null;
    const packageName =
      (typeof body.packageName === "string" && body.packageName.trim())
        ? body.packageName.trim()
        : (ANDROID_PACKAGE_NAME ? String(ANDROID_PACKAGE_NAME).trim() : null);

    if (!sku || !purchaseToken) {
      return res.status(400).json({ ok: false, error: "sku and purchaseToken are required" });
    }

    const offer = getOfferBySku(sku);
    if (!offer) {
      return res.status(400).json({ ok: false, error: "Unknown sku" });
    }

    // Ensure verifier is configured
    if (!isPlayVerifierConfigured()) {
      return res.status(501).json({
        ok: false,
        code: "VERIFIER_NOT_CONFIGURED",
        message:
          "Purchase verification is not configured yet. Set ANDROID_PACKAGE_NAME and GOOGLE_PLAY_SERVICE_ACCOUNT_FILE (or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON).",
      });
    }

    // Verify purchase with Google Play Developer API
    const effectivePackageName = packageName || ANDROID_PACKAGE_NAME;

    let play;
    try {
      play = await verifyGooglePlayInAppPurchase({
        packageName: effectivePackageName,
        productId: sku, // sku/productId are the same in your catalog
        purchaseToken,
      });
    } catch (e) {
      console.error("[Economy] Google Play verification failed", {
        message: e?.message,
        code: e?.code,
      });
      return res.status(400).json({
        ok: false,
        code: "PLAY_VERIFY_FAILED",
        message: e?.message || "Failed to verify purchase with Google Play",
      });
    }

    // Validate state
    if (play.purchaseState !== 0) {
      const stateMsg = play.purchaseState === 2 ? "Purchase is pending" : "Purchase is not completed";
      return res.status(409).json({
        ok: false,
        code: "PURCHASE_NOT_PURCHASED",
        message: stateMsg,
        purchaseState: play.purchaseState,
      });
    }

    const db = getAnalyticsDb();

    // Idempotency: use purchaseToken as the document id.
    // If we already processed this purchaseToken, return success without re-granting.
    const pRef = purchaseDocRef(db, auth.uid, purchaseToken);

    const grantedCookies = getTotalCookiesFromOffer(offer);
    if (grantedCookies <= 0) {
      return res.status(400).json({ ok: false, error: "Offer grants 0 Eggs" });
    }

    let newBalance = null;

    await db.runTransaction(async (tx) => {
      const existingPurchase = await tx.get(pRef);
      if (existingPurchase.exists) {
        const prev = existingPurchase.data() || {};
        newBalance = typeof prev.newBalance === "number" ? prev.newBalance : null;
        return;
      }

      // Load/init economy doc and grant cookies.
      const { ref: econRef, data: econData } = await getOrInitEconomyDocTx(tx, db, auth.uid);
      const currentCookies =
        typeof econData.cookies === "number" && Number.isFinite(econData.cookies)
          ? econData.cookies
          : 0;

      const now = Date.now();
      const nextCookies = currentCookies + grantedCookies;
      newBalance = nextCookies;

      // Update economy balance (no ledger yet; just minimal audit)
      tx.set(
        econRef,
        {
          cookies: nextCookies,
          updatedAt: now,
          _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastGrant: {
            amount: grantedCookies,
            reason: "purchase",
            at: now,
            sku: offer.sku || offer.id,
          },
        },
        { merge: true }
      );
      addEconomyLedgerEntryTx(tx, db, auth.uid, {
        id: `purchase_${String(purchaseToken).trim()}`,
        delta: grantedCookies,
        balanceAfter: nextCookies,
        kind: "purchase",
        reason: "cookie_purchase",
        source: "purchase",
        metadata: {
          sku: offer.sku || offer.id,
          offerId: offer.id,
          purchaseToken,
          orderId: orderId || play.orderId || null,
        },
        createdAt: now,
      });

      // Store purchase record
      tx.set(
        pRef,
        {
          uid: auth.uid,
          sku: offer.sku || offer.id,
          offerId: offer.id,
          grantedCookies,

          // Client-supplied fields
          orderId: orderId || play.orderId || null,
          packageName: play.packageName,
          purchaseToken,

          // Verification snapshot
          play: {
            purchaseState: play.purchaseState,
            consumptionState: play.consumptionState,
            acknowledgementState: play.acknowledgementState,
            orderId: play.orderId,
            purchaseTimeMillis: play.purchaseTimeMillis,
          },

          status: "granted",
          createdAt: now,
          _serverCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
          newBalance: nextCookies,
        },
        { merge: true }
      );
    });

    // Analytics
    try {
      const ctx = getEventContext(req);
      trackEvent("economy_purchase_granted", {
        userId: auth.uid,
        deviceId: ctx.deviceId,
        metadata: {
          sku: offer.sku || offer.id,
          grantedCookies,
          newBalance,
        },
      });
    } catch {}

    return res.json({
      ok: true,
      sku: offer.sku || offer.id,
      productId: offer.sku || offer.id,
      grantedCookies,
      balance: newBalance,
      cookies: newBalance,
      message: "Purchase verified and Eggs granted",
    });
  } catch (err) {
    console.error("❌ /economy/purchases/verify error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Failed to verify purchase" });
  }
}

// Canonical endpoint
app.post("/economy/purchases/verify", handleEconomyPurchaseVerify);

// Alias endpoint used by some clients (keep for compatibility)
app.post("/economy/verify-play", handleEconomyPurchaseVerify);

// DEV ONLY: grant cookies for testing without Play Billing.
// Enabled only if ECONOMY_DEV_GRANT_ENABLED is true and NODE_ENV != production.
app.post("/economy/dev/grant", async (req, res) => {
  try {
    if (!ECONOMY_DEV_GRANT_ENABLED) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    const auth = await requireVerifiedUid(req, res);
    if (!auth) return;

    const body = req.body || {};
    const amount = typeof body.amount === "number" && Number.isFinite(body.amount) ? Math.floor(body.amount) : 0;
    if (amount <= 0) {
      return res.status(400).json({ ok: false, error: "amount must be a positive number" });
    }

    const db = getAnalyticsDb();
    let newBalance = null;

    await db.runTransaction(async (tx) => {
      const { ref: econRef, data: econData } = await getOrInitEconomyDocTx(tx, db, auth.uid);
      const currentCookies =
        typeof econData.cookies === "number" && Number.isFinite(econData.cookies)
          ? econData.cookies
          : 0;
      const now = Date.now();
      const nextCookies = currentCookies + amount;
      newBalance = nextCookies;

      tx.set(
        econRef,
        {
          cookies: nextCookies,
          updatedAt: now,
          _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastGrant: { amount, reason: "dev_grant", at: now },
        },
        { merge: true }
      );
      addEconomyLedgerEntryTx(tx, db, auth.uid, {
        delta: amount,
        balanceAfter: nextCookies,
        kind: "adjustment",
        reason: "dev_grant",
        source: "dev",
        createdAt: now,
      });
    });

    return res.json({ ok: true, granted: amount, cookies: newBalance, balance: newBalance });
  } catch (err) {
    console.error("❌ /economy/dev/grant error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Failed to grant Eggs" });
  }
});

// DEV ONLY: set free premium actions remaining for testing.
// Enabled only if ECONOMY_DEV_GRANT_ENABLED is true and NODE_ENV != production.
app.post("/economy/dev/set-free-premium-actions", async (req, res) => {
  try {
    if (!ECONOMY_DEV_GRANT_ENABLED) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    const auth = await requireVerifiedUid(req, res);
    if (!auth) return;

    const body = req.body || {};
    const value =
      typeof body.value === "number" && Number.isFinite(body.value)
        ? Math.max(0, Math.floor(body.value))
        : null;

    if (value === null) {
      return res.status(400).json({ ok: false, error: "value must be a non-negative number" });
    }

    const db = getAnalyticsDb();
    let cookies = null;

    await db.runTransaction(async (tx) => {
      const { ref: econRef, data: econData } = await getOrInitEconomyDocTx(tx, db, auth.uid);
      const currentCookies =
        typeof econData.cookies === "number" && Number.isFinite(econData.cookies)
          ? econData.cookies
          : 0;
      cookies = currentCookies;
      const now = Date.now();

      tx.set(
        econRef,
        {
          freePremiumActionsRemaining: value,
          updatedAt: now,
          _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      addEconomyLedgerEntryTx(tx, db, auth.uid, {
        delta: 0,
        balanceAfter: currentCookies,
        freePremiumActionsAfter: value,
        kind: "adjustment",
        reason: "dev_set_free_premium_actions",
        source: "dev",
        metadata: { value },
        createdAt: now,
      });
    });

    return res.json({
      ok: true,
      freePremiumActionsRemaining: value,
      cookies,
      balance: cookies,
    });
  } catch (err) {
    console.error("❌ /economy/dev/set-free-premium-actions error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Failed to update free premium actions" });
  }
});

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
 *
 * In production, events are stored in Firestore in a single top-level
 * collection (e.g. "AnalyticEvents") so that you can compute global
 * statistics easily.
 *
 * Shape of each event doc:
 * {
 *   ts: ISO string,
 *   eventType: string,
 *   userId: string | null,
 *   deviceId: string | null,
 *   metadata: { ...originalMetadata, _env: "<backend env>", appEnv?: "<frontend env>" }
 * }
 *
 * If Firestore is unavailable or ANALYTICS_USE_FIRESTORE is not enabled,
 * events are appended to a local log file.
 */
function trackEvent(
  eventType,
  { userId = null, deviceId = null, metadata = null } = {}
) {
  try {
    const envTag = ANALYTICS_ENV;

    // Always store env info inside metadata
    const mergedMetadata = {
      ...(metadata && typeof metadata === "object" ? metadata : {}),
      _env: envTag, // backend environment (local-backend / preview-backend / production-backend)
    };

    const payload = {
      ts: new Date().toISOString(),
      eventType,
      userId,
      deviceId,
      metadata: mergedMetadata,
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
        // Use the analytics Firestore client (supports multi-database via FIREBASE_DATABASE_ID)
        const db = getAnalyticsDb();

        // ✅ All analytics events go to a single top-level collection
        const collectionRef = db.collection(ANALYTICS_COLLECTION);

        // Fire-and-forget write; internal catch logs any Firestore issues
        collectionRef.add(payload).catch((err) => {
          console.error("❌ Failed to write analytics event to Firestore:", {
            message: err?.message,
            code: err?.code,
            details: err?.details,
            stack: err?.stack,
          });
        });
      } catch (err) {
        console.error("❌ Analytics Firestore error, falling back to file:", {
          message: err?.message,
          code: err?.code,
          details: err?.details,
          stack: err?.stack,
        });
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
      // Fallback: append to local analytics log file
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
  } catch (err) {
    console.error("❌ Analytics error:", err?.message || err);
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

/**
 * Generic event ingestion endpoint for the mobile app.
 * The app sends:
 *   POST /events
 *   Headers:
 *     Authorization: Bearer <FIREBASE_ID_TOKEN>
 *   Body JSON:
 *     {
 *       "type": "debug_manual_test",   // required
 *       "ts": 1731600000000,           // optional client timestamp
 *       ... any other fields as payload ...
 *     }
 *
 * This endpoint:
 *   - Verifies the Firebase ID token
 *   - Derives userId from the token (uid)
 *   - Uses x-device-id (if present) as deviceId
 *   - Stores the event via trackEvent (which may write to Firestore if ANALYTICS_USE_FIRESTORE is enabled)
 */
app.post("/events", async (req, res) => {
  try {
    if (!_adminInitialized) {
      console.error("[/events] Admin SDK not initialized");
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    // Verify Firebase ID token from Authorization header
    let decoded;
    try {
      decoded = await verifyIdTokenFromHeader(req);
    } catch (e) {
      console.error("[/events] Token verification failed:", e?.message || e);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body || {};
    const type =
      typeof body.type === "string" && body.type.trim()
        ? body.type.trim()
        : "";

    if (!type) {
      return res.status(400).json({ error: "type is required" });
    }

    // Extract optional client timestamp and payload
    const clientTs =
      typeof body.ts === "number" && Number.isFinite(body.ts)
        ? body.ts
        : Date.now();

    const { ts, type: _ignoredType, ...restPayload } = body;

    // Best-effort context from headers (for deviceId)
    const headerCtx = getEventContext(req);
    const userId = decoded && decoded.uid ? decoded.uid : headerCtx.userId || null;
    const deviceId = headerCtx.deviceId || null;

    const metadata = {
      ...restPayload,
      clientTs,
      backendReceivedAt: Date.now(),
    };

    // Use the existing analytics tracker; if ANALYTICS_USE_FIRESTORE=1,
    // this will store the event under the configured analytics collection.
    trackEvent(type, {
      userId,
      deviceId,
      metadata,
    });

    if (process.env.NODE_ENV !== "production") {
      console.log("[/events] Tracked event:", {
        type,
        userId,
        deviceId,
        metadata,
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /events error:", err?.message || err);
    return res.status(500).json({ error: "Failed to record event" });
  }
});

app.get("/debug/sync-state", async (req, res) => {
  try {
    const uid = typeof req.query.uid === "string" && req.query.uid.trim() ? req.query.uid.trim() : null;
    if (!uid) return res.status(400).json({ ok: false, error: "uid query param is required" });

    const db = getAnalyticsDb();

    const cookbooksSnap = await db.collection(`users/${uid}/cookbooks`).get();
    const cookbookIds = [];
    cookbooksSnap.forEach(d => cookbookIds.push(d.id));

    const prefsSnap = await db.doc(`users/${uid}/preferences/default`).get();

    return res.json({
      ok: true,
      uid,
      cookbooks: { count: cookbooksSnap.size, idsSample: cookbookIds.slice(0, 20) },
      preferences: { exists: prefsSnap.exists, keys: prefsSnap.exists ? Object.keys(prefsSnap.data() || {}).slice(0, 30) : [] },
    });
  } catch (err) {
    console.error("❌ /debug/sync-state error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "debug_failed", details: err?.message || String(err) });
  }
});

/**
 * Debug endpoint: write arbitrary data from the mobile app into Firestore
 * using the Admin SDK. This bypasses Firestore security rules and uses
 * the same project/bucket as analytics events.
 *
 * Body:
 *   {
 *     "userId": "uid-123",
 *     "path": "users/uid-123/debugMobileWrites/fromBackend",
 *     "data": { ...any JSON... }
 *   }
 *
 * If "path" is omitted, we default to:
 *   users/{userId}/debugMobileWrites/fromBackend
 */
app.post("/mobile-firestore-debug", async (req, res) => {
  try {
    const { userId, path, data } = req.body || {};

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    if (!_adminInitialized) {
      console.error("[mobile-firestore-debug] Admin SDK not initialized");
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    // ✅ Use the same Firestore database instance / ID as analytics
    const db = getAnalyticsDb();

    const docPath =
      path || `users/${userId}/debugMobileWrites/fromBackend`;

    console.log("[mobile-firestore-debug] incoming", {
      userId,
      path: docPath,
    });

    await db.doc(docPath).set(
      {
        ...(data || {}),
        _debugSource: "mobile-firestore-debug",
        _serverTs: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log("[mobile-firestore-debug] write SUCCESS", { path: docPath });

    return res.json({ ok: true, path: docPath });
  } catch (err) {
    console.error("[mobile-firestore-debug] write FAILED", err);
    return res.status(500).json({
      error: "internal",
      details:
        err && err.message ? err.message : String(err),
    });
  }
});

// ---------------- Preferences Sync Endpoints ----------------
// These endpoints are used by the mobile app to synchronize user preferences
// between AsyncStorage on the device and Firestore under:
//   users/{uid}/preferences/default
app.get("/sync/preferences", async (req, res) => {
  try {
    console.log("[/sync/preferences GET] called", {
      hasAuthHeader: !!(req.headers["authorization"] || req.headers["Authorization"]),
    });
    if (!_adminInitialized) {
      console.error("[/sync/preferences] Admin SDK not initialized");
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    let decoded;
    try {
      decoded = await verifyIdTokenFromHeader(req);
    } catch (e) {
      console.error("[/sync/preferences] Token verification failed:", e?.message || e);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const uid = decoded && decoded.uid;
    if (!uid) {
      return res.status(400).json({ error: "Missing user id" });
    }
    console.log("[/sync/preferences GET] uid", uid);

    const db = getAnalyticsDb();
    const docRef = db.doc(`users/${uid}/preferences/default`);
    const snap = await docRef.get();

    if (!snap.exists) {
      console.log("[/sync/preferences GET] returning", { uid, hasDoc: false });
      return res.json({ doc: null });
    }

    const data = snap.data() || {};

    // Normalize updatedAt to a number when possible (for comparisons on the client)
    if (typeof data.updatedAt === "string") {
      const num = Number(data.updatedAt);
      if (Number.isFinite(num)) {
        data.updatedAt = num;
      }
    }

    console.log("[/sync/preferences GET] returning", { uid, hasDoc: true, keys: Object.keys(data || {}).slice(0, 20) });
    return res.json({ doc: data });
  } catch (err) {
    console.error("❌ /sync/preferences (GET) error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load preferences" });
  }
});

app.post("/sync/preferences", async (req, res) => {
  try {
    console.log("[/sync/preferences POST] called", {
      hasAuthHeader: !!(req.headers["authorization"] || req.headers["Authorization"]),
      bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body) : null,
    });
    if (!_adminInitialized) {
      console.error("[/sync/preferences] Admin SDK not initialized");
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    let decoded;
    try {
      decoded = await verifyIdTokenFromHeader(req);
    } catch (e) {
      console.error("[/sync/preferences] Token verification failed:", e?.message || e);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const uid = decoded && decoded.uid;
    if (!uid) {
      return res.status(400).json({ error: "Missing user id" });
    }
    console.log("[/sync/preferences POST] uid", uid);

    const body = req.body || {};
    const doc = body.doc;
    console.log("[/sync/preferences POST] doc summary", {
      uid,
      hasDoc: !!doc,
      docKeys: doc && typeof doc === "object" ? Object.keys(doc).slice(0, 30) : null,
    });

    if (!doc || typeof doc !== "object") {
      return res.status(400).json({ error: "doc object is required" });
    }

    const now = Date.now();

    const payload = {
      ...doc,
      updatedAt:
        typeof doc.updatedAt === "number" && Number.isFinite(doc.updatedAt)
          ? doc.updatedAt
          : now,
      _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!payload.createdAt) {
      payload.createdAt = now;
    }

    const db = getAnalyticsDb();
    const docRef = db.doc(`users/${uid}/preferences/default`);
    await docRef.set(payload, { merge: true });

    // Optional analytics event (goes into the analyticsEvents collection)
    try {
      const ctx = getEventContext(req);
      trackEvent("sync_preferences_write", {
        userId: uid,
        deviceId: ctx.deviceId,
        metadata: {
          hasDoc: true,
        },
      });
    } catch (e) {
      console.warn("[/sync/preferences] analytics log failed:", e?.message || e);
    }

    console.log("[/sync/preferences POST] write OK", { uid });
    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /sync/preferences (POST) error:", err?.message || err);
    return res.status(500).json({ error: "Failed to save preferences" });
  }
});

// ---------------- My Day Sync Endpoints ----------------

app.get("/sync/myday/profile", async (req, res) => {
  try {
    if (!_adminInitialized) {
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    const authResolution = await resolveLegacySyncUid(req);
    if (!authResolution.ok || !authResolution.uid) {
      return res
        .status(authResolution.status || 401)
        .json({ error: authResolution.error || "Unauthorized" });
    }
    const uid = authResolution.uid;

    const db = getAnalyticsDb();
    const snap = await db.doc(`users/${uid}/myDay/profile`).get();
    if (!snap.exists) {
      return res.json({ doc: null });
    }
    return res.json({ doc: snap.data() || null });
  } catch (err) {
    console.error("❌ /sync/myday/profile (GET) error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load My Day profile" });
  }
});

app.post("/sync/myday/profile", async (req, res) => {
  try {
    if (!_adminInitialized) {
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    const authResolution = await resolveLegacySyncUid(req);
    if (!authResolution.ok || !authResolution.uid) {
      return res
        .status(authResolution.status || 401)
        .json({ error: authResolution.error || "Unauthorized" });
    }
    const uid = authResolution.uid;

    const doc = req.body?.doc;
    if (!doc || typeof doc !== "object") {
      return res.status(400).json({ error: "doc object is required" });
    }

    const now = Date.now();
    const payload = stripUndefinedDeep({
      ...doc,
      updatedAt:
        typeof doc.updatedAt === "number" && Number.isFinite(doc.updatedAt)
          ? doc.updatedAt
          : now,
      schemaVersion:
        typeof doc.schemaVersion === "number" && Number.isFinite(doc.schemaVersion)
          ? doc.schemaVersion
          : 1,
      _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const db = getAnalyticsDb();
    await db.doc(`users/${uid}/myDay/profile`).set(payload, { merge: true });
    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /sync/myday/profile (POST) error:", err?.message || err);
    return res.status(500).json({ error: "Failed to save My Day profile" });
  }
});

app.post("/sync/myday/meals/pull", async (req, res) => {
  try {
    if (!_adminInitialized) {
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    const authResolution = await resolveLegacySyncUid(req);
    if (!authResolution.ok || !authResolution.uid) {
      return res
        .status(authResolution.status || 401)
        .json({ error: authResolution.error || "Unauthorized" });
    }
    const uid = authResolution.uid;

    const db = getAnalyticsDb();
    const snap = await db.collection(`users/${uid}/myDayMeals`).get();
    const items = [];
    snap.forEach((doc) => items.push({ id: doc.id, ...(doc.data() || {}) }));
    return res.json({ items });
  } catch (err) {
    console.error("❌ /sync/myday/meals/pull error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load My Day meals" });
  }
});

app.post("/sync/myday/meals/push", async (req, res) => {
  try {
    if (!_adminInitialized) {
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    const authResolution = await resolveLegacySyncUid(req);
    if (!authResolution.ok || !authResolution.uid) {
      return res
        .status(authResolution.status || 401)
        .json({ error: authResolution.error || "Unauthorized" });
    }
    const uid = authResolution.uid;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    const db = getAnalyticsDb();
    const batch = db.batch();
    const now = Date.now();
    let upserted = 0;
    let deleted = 0;

    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const id =
        typeof raw.id === "string" && raw.id.trim()
          ? raw.id.trim()
          : null;
      if (!id) continue;

      const ref = db.doc(`users/${uid}/myDayMeals/${id}`);
      if (raw.isDeleted === true) {
        batch.delete(ref);
        deleted += 1;
        continue;
      }

      const payload = stripUndefinedDeep({
        ...raw,
        updatedAt:
          typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
            ? raw.updatedAt
            : now,
        schemaVersion:
          typeof raw.schemaVersion === "number" && Number.isFinite(raw.schemaVersion)
            ? raw.schemaVersion
            : 1,
        _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      delete payload.id;
      batch.set(ref, payload, { merge: true });
      upserted += 1;
    }

    await batch.commit();
    return res.json({ ok: true, upserted, deleted });
  } catch (err) {
    console.error("❌ /sync/myday/meals/push error:", err?.message || err);
    return res.status(500).json({ error: "Failed to save My Day meals" });
  }
});

app.post("/sync/myday/weights/pull", async (req, res) => {
  try {
    if (!_adminInitialized) {
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    const authResolution = await resolveLegacySyncUid(req);
    if (!authResolution.ok || !authResolution.uid) {
      return res
        .status(authResolution.status || 401)
        .json({ error: authResolution.error || "Unauthorized" });
    }
    const uid = authResolution.uid;

    const db = getAnalyticsDb();
    const snap = await db.collection(`users/${uid}/myDayWeights`).get();
    const items = [];
    snap.forEach((doc) => items.push({ id: doc.id, ...(doc.data() || {}) }));
    return res.json({ items });
  } catch (err) {
    console.error("❌ /sync/myday/weights/pull error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load My Day weights" });
  }
});

app.post("/sync/myday/weights/push", async (req, res) => {
  try {
    if (!_adminInitialized) {
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    const authResolution = await resolveLegacySyncUid(req);
    if (!authResolution.ok || !authResolution.uid) {
      return res
        .status(authResolution.status || 401)
        .json({ error: authResolution.error || "Unauthorized" });
    }
    const uid = authResolution.uid;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    const db = getAnalyticsDb();
    const batch = db.batch();
    const now = Date.now();
    let upserted = 0;
    let deleted = 0;

    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const id =
        typeof raw.id === "string" && raw.id.trim()
          ? raw.id.trim()
          : null;
      if (!id) continue;

      const ref = db.doc(`users/${uid}/myDayWeights/${id}`);
      if (raw.isDeleted === true) {
        batch.delete(ref);
        deleted += 1;
        continue;
      }

      const payload = stripUndefinedDeep({
        ...raw,
        updatedAt:
          typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
            ? raw.updatedAt
            : now,
        schemaVersion:
          typeof raw.schemaVersion === "number" && Number.isFinite(raw.schemaVersion)
            ? raw.schemaVersion
            : 1,
        _serverUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      delete payload.id;
      batch.set(ref, payload, { merge: true });
      upserted += 1;
    }

    await batch.commit();
    return res.json({ ok: true, upserted, deleted });
  } catch (err) {
    console.error("❌ /sync/myday/weights/push error:", err?.message || err);
    return res.status(500).json({ error: "Failed to save My Day weights" });
  }
});

// ---------------- Ingredient Catalog Endpoints ----------------
app.get("/ingredients/catalog/manifest", async (req, res) => {
  try {
    const db = _adminInitialized ? getAnalyticsDb() : null;
    const manifestSnap = db ? await ingredientCatalogDocRef(db).get() : null;
    const manifest = manifestSnap?.exists ? manifestSnap.data() || {} : {};
    const combinedItems = await getCombinedIngredientCatalogItems(db);

    return res.json({
      manifest: {
        version: String(manifest.version || INGREDIENT_CATALOG_SEED_MANIFEST.version),
        updatedAt:
          typeof manifest.updatedAt === "number" && manifest.updatedAt > 0
            ? Math.max(manifest.updatedAt, INGREDIENT_CATALOG_SEED_MANIFEST.updatedAt)
            : INGREDIENT_CATALOG_SEED_MANIFEST.updatedAt,
        locales:
          Array.isArray(manifest.locales) && manifest.locales.length > 0
            ? manifest.locales
            : SUPPORTED_INGREDIENT_LOCALES,
        itemCount: combinedItems.length,
      },
    });
  } catch (err) {
    console.error("❌ /ingredients/catalog/manifest error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load ingredient catalog manifest" });
  }
});

app.get("/ingredients/catalog/items", async (req, res) => {
  try {
    const db = _adminInitialized ? getAnalyticsDb() : null;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 5000)) : 2000;
    const updatedAfterRaw = Number(req.query.updatedAfter);
    const updatedAfter = Number.isFinite(updatedAfterRaw) ? updatedAfterRaw : null;
    const combinedItems = await getCombinedIngredientCatalogItems(db);
    const filteredItems =
      updatedAfter !== null
        ? combinedItems.filter((item) => item.updatedAt > updatedAfter)
        : combinedItems;
    const items = filteredItems.slice(0, limit);

    return res.json({
      items,
      cursor: items.length > 0 ? items[items.length - 1].updatedAt : null,
    });
  } catch (err) {
    console.error("❌ /ingredients/catalog/items error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load ingredient catalog items" });
  }
});

app.post("/ingredients/catalog/candidates", async (req, res) => {
  try {
    if (!_adminInitialized) {
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    const authCtx = await getEconomyAuthContext(req);
    if (!authCtx?.uid) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const candidate = req.body?.candidate;
    if (!candidate || typeof candidate !== "object") {
      return res.status(400).json({ error: "candidate object is required" });
    }

    const db = getAnalyticsDb();
    const persisted = await persistIngredientCatalogCandidate({
      db,
      candidate,
      submittedByUid: authCtx.uid,
    });

    return res.json({
      ok: true,
      candidateId: persisted.candidateId,
      autoPromotion: {
        shouldPromote: persisted.scored.shouldPromote,
        score: persisted.scored.score,
        reasons: persisted.scored.reasons,
      },
      item: persisted.item,
      localEntry: persisted.localEntry,
    });
  } catch (err) {
    console.error("❌ /ingredients/catalog/candidates error:", err?.message || err);
    return res.status(500).json({ error: "Failed to submit ingredient catalog candidate" });
  }
});

function ingredientLocaleFromLanguage(language) {
  const normalized = String(language || "").trim().toLowerCase();
  if (normalized.includes("brazil") || normalized.includes("brasil") || normalized.startsWith("pt-br")) return "pt-BR";
  if (normalized.includes("portuguese") || normalized.includes("português") || normalized.startsWith("pt")) return "pt-PT";
  if (normalized.includes("spanish") || normalized.includes("español") || normalized.startsWith("es")) return "es";
  if (normalized.includes("french") || normalized.includes("français") || normalized.startsWith("fr")) return "fr";
  if (normalized.includes("german") || normalized.includes("deutsch") || normalized.startsWith("de")) return "de";
  return "en";
}

function buildRuntimeIngredientAliases({ canonicalName, displayName, sourceText, requestedName, requestedLocale }) {
  const values = Array.from(
    new Set(
      [requestedName, displayName, sourceText, canonicalName]
        .map((value) => normalizeAlias(value || ""))
        .filter(Boolean)
    )
  );
  const fallback = values.length > 0 ? values : ["ingredient"];
  const canonicalOnly = normalizeAlias(canonicalName || "") ? [normalizeAlias(canonicalName)] : fallback;
  return Object.fromEntries(
    SUPPORTED_INGREDIENT_LOCALES.map((locale) => [
      locale,
      locale === requestedLocale ? fallback : canonicalOnly,
    ])
  );
}

function runtimeFoodText(item, requestedName = "") {
  return [
    item?.sourceText,
    item?.displayName,
    item?.canonicalName,
    requestedName,
  ]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeRuntimeQuantity(quantity, fallback = { quantity: 1, unit: "g" }) {
  const rawQuantity = Number(quantity?.quantity);
  const unit = String(quantity?.unit || fallback?.unit || "g").toLowerCase();
  return {
    quantity: Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : Number(fallback?.quantity) || 1,
    unit,
  };
}

function clampRuntimeIngredientQuantity(quantity, item, requestedName = "") {
  const text = runtimeFoodText(item, requestedName);
  const normalized = normalizeRuntimeQuantity(quantity);

  const isOil =
    /\b(olive oil|oil|azeite|aceite|huile|olivenol)\b/.test(text) &&
    !/\b(coconut oil|coconut milk|leite de coco)\b/.test(text);
  const isTinyOil =
    /\b(fio de|drizzle of|splash of|dash of|chorrito de|filet d['’]?|q\.?\s*b\.?|quanto baste|as needed|to taste)\b/.test(
      text
    );
  if (isOil && isTinyOil) {
    return { quantity: 5, unit: normalized.unit === "ml" ? "ml" : "g" };
  }
  if (isOil && ["g", "ml"].includes(normalized.unit) && normalized.quantity > 20) {
    return { quantity: 14, unit: normalized.unit };
  }

  const isEggYolk = /\b(egg yolks?|yolks?|gema|gemas|eigelb|yema|yemas|jaune)\b/.test(text);
  if (isEggYolk && ["g", "ml"].includes(normalized.unit) && normalized.quantity > 30) {
    return { quantity: 18, unit: "g" };
  }

  const isEggWhite = /\b(egg whites?|whites?|clara|claras|eiweiss|blanc d oeuf)\b/.test(text);
  if (isEggWhite && ["g", "ml"].includes(normalized.unit) && normalized.quantity > 50) {
    return { quantity: 33, unit: "g" };
  }

  const isWholeEgg = /\b(eggs?|ovos?|huevos?|oeufs?|eier?)\b/.test(text);
  const isPreparedEggServing =
    /\b(scrambled eggs|ovo[s]? mexido[s]?|huevos? revueltos?|oeufs? brouilles?|rührei|ruhrei|boiled eggs|ovos? cozidos?|huevos? cocidos?|oeufs? durs?|gekochte eier)\b/.test(text);
  if (isWholeEgg && isPreparedEggServing && ["g", "ml"].includes(normalized.unit) && normalized.quantity < 90) {
    return { quantity: 100, unit: "g" };
  }
  if (isWholeEgg && ["g", "ml"].includes(normalized.unit) && normalized.quantity > 80) {
    return { quantity: 50, unit: "g" };
  }

  return normalized;
}

function sanitizeRuntimeResolvedIngredient(item, requestedName = "") {
  if (!item || typeof item !== "object") return item;
  return {
    ...item,
    defaultServing: clampRuntimeIngredientQuantity(item.defaultServing, item, requestedName),
    resolvedQuantity: clampRuntimeIngredientQuantity(item.resolvedQuantity, item, requestedName),
  };
}

function clampMealTextResolvedQuantity(item, input = "") {
  const quantity = Number(item?.quantity);
  const unit = String(item?.unit || "").toLowerCase();
  const text = String(item?.name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const contextText = String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const fullText = `${text} ${contextText}`;

  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (!["g", "ml"].includes(unit)) return null;

  const isSolidFood =
    /\b(banana|bread|toast|pao|paes|pan|pain|brot|egg|eggs|ovo|ovos|huevo|huevos|oeuf|oeufs|eier|ei|oats|oatmeal|aveia|avena|flocons|hafer|yogurt|iogurte|yogur|yaourt|joghurt|cottage|sandwich|sandes|sanduiche|wrap|omelet|omelette|omelete|tortilla|omelett|rice bowl|bowl|bol|reisschussel|cake|bolo|tarta|gateau|kuchen|sushi|pizza|lasagna|lasanha|lasana|lasaña|lasagne|shrimp|gambas|crevettes|garnelen)\b/.test(text);
  if (unit === "ml" && isSolidFood) {
    return { quantity, unit: "g" };
  }

  if (/\b(cottage|fromage cottage|huttenkase|huettenkaese|huttenkase)\b/.test(text) && unit === "g" && quantity < 80) {
    return { quantity: 150, unit: "g" };
  }
  if (/\b(wrap)\b/.test(text) && unit === "g" && quantity < 120) {
    return { quantity: 220, unit: "g" };
  }
  if (/\b(avocado toast|torrada de abacate|tostada de aguacate|toast avocat|avocado-toast)\b/.test(text) && unit === "g" && quantity < 100) {
    return { quantity: 150, unit: "g" };
  }

  const isTiny = quantity < 5;
  if (!isTiny) return { quantity, unit };

  const asQuantity = (nextQuantity, nextUnit = unit) => ({ quantity: nextQuantity, unit: nextUnit });

  if (/\b(protein shake|shake de proteina|batido de proteina|shake proteine|proteinshake)\b/.test(text)) {
    return asQuantity(250, "ml");
  }
  if (/\b(leite achocolatado|schokomilch|lait chocolate|leche chocolateada|chocolate milk)\b/.test(text)) {
    return asQuantity(250, "ml");
  }
  if (/\b(soup|sopa|soupe|suppe|caldo)\b/.test(text)) {
    return asQuantity(300, "ml");
  }
  if (/\b(banana|platano|platanos|banane)\b/.test(text)) {
    return asQuantity(120, "g");
  }
  if (/\b(bread slice|slice of bread|fatia de pao|rebanada de pan|tranche de pain|scheibe brot)\b/.test(text)) {
    return asQuantity(30, "g");
  }
  if (/\b(bread|toast|pao|paes|pan|pain|brot)\b/.test(text)) {
    const hasTwo = /\b(2|two|dois|duas|dos|deux|zwei)\b/.test(fullText);
    return asQuantity(hasTwo ? 120 : 30, "g");
  }
  if (/\b(egg|eggs|ovo|ovos|huevo|huevos|oeuf|oeufs|eier|ei|ruhrei|ruehrei|rührei)\b/.test(text)) {
    const hasTwo = /\b(2|two|dois|duas|dos|deux|zwei)\b/.test(fullText);
    return asQuantity(hasTwo ? 100 : 50, "g");
  }
  if (/\b(oats|oatmeal|aveia|avena|flocons|flocons d avoine|hafer|haferbrei)\b/.test(text)) {
    return asQuantity(40, "g");
  }
  if (/\b(sushi)\b/.test(text)) {
    return asQuantity(180, "g");
  }
  if (/\b(shrimp|gambas|crevettes|garnelen)\b/.test(text)) {
    return asQuantity(150, "g");
  }
  if (/\b(yogurt|iogurte|yogur|yaourt|joghurt)\b/.test(text)) {
    return asQuantity(125, "g");
  }
  if (/\b(cottage|fromage cottage|huttenkase|huettenkaese|huttenkase)\b/.test(text)) {
    return asQuantity(150, "g");
  }
  if (/\b(sandwich|sandes|sanduiche|sandwich|thunfisch sandwich)\b/.test(text)) {
    const isHalf = /\b(half|meia|meio|medio|demi|halbes?)\b/.test(fullText);
    return asQuantity(isHalf ? 110 : 220, "g");
  }
  if (/\b(wrap)\b/.test(text)) {
    return asQuantity(220, "g");
  }
  if (/\b(omelet|omelette|omelete|tortilla|omelett)\b/.test(text)) {
    return asQuantity(150, "g");
  }
  if (/\b(rice bowl|bowl de arroz|bol de arroz|bol de riz|reisschussel|reisschüssel)\b/.test(text)) {
    return asQuantity(200, "g");
  }
  if (/\b(cake|bolo|tarta|gateau|kuchen)\b/.test(text)) {
    return asQuantity(80, "g");
  }

  return { quantity, unit };
}

function buildRuntimeResolvedLocalEntry(item, language, requestedName) {
  const canonicalName = normalizeAlias(item?.canonicalName || item?.displayName || item?.sourceText || "");
  const displayName = sanitizeInput(item?.displayName || item?.canonicalName || item?.sourceText || canonicalName);
  const requestedLocale = ingredientLocaleFromLanguage(language);
  const aliases = buildRuntimeIngredientAliases({
    canonicalName,
    displayName,
    sourceText: item?.sourceText,
    requestedName,
    requestedLocale,
  });
  const nutritionPer100 = item?.nutritionPer100 || {};
  const defaultServing = item?.defaultServing || item?.resolvedQuantity || {};

  return serializeIngredientCatalogItem(
    `runtime_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    {
      canonicalName,
      category: sanitizeInput(item?.category || "") || null,
      aliases,
      nutritionPer100: {
        calories: Number(nutritionPer100.calories),
        protein: Number(nutritionPer100.protein),
        carbs: Number(nutritionPer100.carbs),
        fat: Number(nutritionPer100.fat),
        unit: nutritionPer100.unit === "ml" ? "ml" : "g",
      },
      defaultServing: {
        quantity: Number(defaultServing.quantity),
        unit: String(defaultServing.unit || "g").toLowerCase(),
      },
      source: "ai_resolved",
      updatedAt: Date.now(),
    }
  );
}

function queueIngredientCatalogCandidateFromRuntime({ item, req }) {
  if (!_adminInitialized || !item?.localEntry) return;
  setImmediate(async () => {
    try {
      const db = getAnalyticsDb();
      const authCtx = await getEconomyAuthContext(req).catch(() => ({ uid: null }));
      await persistIngredientCatalogCandidate({
        db,
        submittedByUid: authCtx?.uid || null,
        candidate: {
          canonicalName: item.localEntry.canonicalName,
          category: item.localEntry.category ?? null,
          aliases: item.localEntry.aliases || {},
          nutritionPer100: item.localEntry.nutritionPer100,
          defaultServing: item.localEntry.defaultServing,
          sourceText: item.sourceText || null,
          confidence: item.confidence ?? null,
          createdAt: Date.now(),
        },
      });
    } catch (err) {
      console.warn("[IngredientRuntimeResolve] Candidate queue failed:", err?.message || err);
    }
  });
}

app.post("/ingredients/runtime/resolve", async (req, res) => {
  try {
    const rawIngredients = Array.isArray(req.body?.ingredients) ? req.body.ingredients : [];
    const language = normalizeLanguage(req.body?.language);
    const ingredients = rawIngredients
      .map((entry) => ({
        sourceText: sanitizeInput(entry?.sourceText || ""),
        name: sanitizeInput(entry?.name || ""),
      }))
      .filter((entry) => entry.sourceText || entry.name)
      .slice(0, 4);

    if (ingredients.length === 0) {
      return res.status(400).json({ error: "ingredients array is required" });
    }

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          minItems: ingredients.length,
          maxItems: ingredients.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "sourceText",
              "displayName",
              "canonicalName",
              "category",
              "nutritionPer100",
              "defaultServing",
              "resolvedQuantity",
              "confidence",
            ],
            properties: {
              sourceText: { type: "string" },
              displayName: { type: "string" },
              canonicalName: { type: "string" },
              category: { type: "string" },
              nutritionPer100: {
                type: "object",
                additionalProperties: false,
                required: ["calories", "protein", "carbs", "fat", "unit"],
                properties: {
                  calories: { type: "number" },
                  protein: { type: "number" },
                  carbs: { type: "number" },
                  fat: { type: "number" },
                  unit: { type: "string", enum: ["g", "ml"] },
                },
              },
              defaultServing: {
                type: "object",
                additionalProperties: false,
                required: ["quantity", "unit"],
                properties: {
                  quantity: { type: "number" },
                  unit: {
                    type: "string",
                    enum: ["g", "kg", "ml", "l"],
                  },
                },
              },
              resolvedQuantity: {
                type: "object",
                additionalProperties: false,
                required: ["quantity", "unit"],
                properties: {
                  quantity: { type: "number" },
                  unit: {
                    type: "string",
                    enum: ["g", "kg", "ml", "l"],
                  },
                },
              },
              confidence: { type: "number" },
            },
          },
        },
      },
    };

    const prompt = `
Resolve these food ingredient phrases for immediate meal nutrition calculation.

Rules:
- Return exactly one item per input, in the same order.
- displayName should be short and user-friendly in the app language when possible (${language}).
- canonicalName should be a clear English ingredient name.
- nutritionPer100 must be realistic per 100 g or 100 ml.
- resolvedQuantity must represent the sourceText amount:
  - explicit weight/volume: keep it;
  - count or household unit: convert to realistic edible amount in g or ml;
  - no valid quantity: use a usual one-person serving for that ingredient in g or ml.
- Do not generate multilingual aliases, catalog metadata, explanations, or extra fields.

Input:
${JSON.stringify(ingredients, null, 2)}
`;

    let raw = await requestStructuredJsonCompletion({
      schemaName: "ingredient_runtime_resolution",
      schema,
      temperature: 0.1,
      timeoutMs: 10000,
      messages: [
        {
          role: "system",
          content:
            "You are a fast food nutrition resolver. Return compact valid JSON only. Prioritize immediate meal logging accuracy over catalog completeness.",
        },
        { role: "user", content: prompt },
      ],
    });

    raw = cleanJsonResponse(raw);
    const parsed = safeJSONParse(raw, {});
    const aiItems = Array.isArray(parsed?.items) ? parsed.items : [];
    const resolved = [];

    for (const [index, rawItem] of aiItems.entries()) {
      const requestedName = ingredients[index]?.name || "";
      const item = sanitizeRuntimeResolvedIngredient(rawItem, requestedName);
      const localEntry = buildRuntimeResolvedLocalEntry(item, language, requestedName);
      if (!localEntry) continue;
      const resolvedItem = {
        sourceText: item?.sourceText || "",
        resolvedQuantity: item?.resolvedQuantity || localEntry.defaultServing,
        confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : null,
        localEntry,
      };
      resolved.push(resolvedItem);
      queueIngredientCatalogCandidateFromRuntime({ item: resolvedItem, req });
    }

    return res.json({ ok: true, items: resolved });
  } catch (err) {
    console.error("❌ /ingredients/runtime/resolve error:", err?.message || err);
    return res.status(500).json({ error: "Failed to resolve meal ingredients" });
  }
});

app.post("/ingredients/catalog/resolve", async (req, res) => {
  try {
    const rawIngredients = Array.isArray(req.body?.ingredients) ? req.body.ingredients : [];
    const language = normalizeLanguage(req.body?.language);
    const ingredients = rawIngredients
      .map((entry) => ({
        sourceText: sanitizeInput(entry?.sourceText || ""),
        name: sanitizeInput(entry?.name || ""),
      }))
      .filter((entry) => entry.sourceText || entry.name)
      .slice(0, 8);

    if (ingredients.length === 0) {
      return res.status(400).json({ error: "ingredients array is required" });
    }

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          minItems: ingredients.length,
          maxItems: ingredients.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "sourceText",
              "canonicalName",
              "category",
              "aliases",
              "nutritionPer100",
              "defaultServing",
              "resolvedQuantity",
              "confidence",
            ],
            properties: {
              sourceText: { type: "string" },
              canonicalName: { type: "string" },
              category: { type: "string" },
              aliases: {
                type: "object",
                additionalProperties: false,
                required: SUPPORTED_INGREDIENT_LOCALES,
                properties: Object.fromEntries(
                  SUPPORTED_INGREDIENT_LOCALES.map((locale) => [
                    locale,
                    {
                      type: "array",
                      minItems: 1,
                      items: { type: "string" },
                    },
                  ])
                ),
              },
              nutritionPer100: {
                type: "object",
                additionalProperties: false,
                required: ["calories", "protein", "carbs", "fat", "unit"],
                properties: {
                  calories: { type: "number" },
                  protein: { type: "number" },
                  carbs: { type: "number" },
                  fat: { type: "number" },
                  unit: { type: "string", enum: ["g", "ml"] },
                },
              },
              defaultServing: {
                type: "object",
                additionalProperties: false,
                required: ["quantity", "unit"],
                properties: {
                  quantity: { type: "number" },
                  unit: {
                    type: "string",
                    enum: ["g", "kg", "ml", "l", "unit", "slice", "cup", "tbsp", "tsp"],
                  },
                },
              },
              resolvedQuantity: {
                type: "object",
                additionalProperties: false,
                required: ["quantity", "unit"],
                properties: {
                  quantity: { type: "number" },
                  unit: {
                    type: "string",
                    enum: ["g", "kg", "ml", "l", "unit", "slice", "cup", "tbsp", "tsp"],
                  },
                },
              },
              confidence: { type: "number" },
            },
          },
        },
      },
    };

    const prompt = `
Resolve the following food ingredient phrases into structured catalog entries.

Rules:
- canonicalName must be in English and be a clear food/ingredient name.
- Provide aliases for all supported locales: en, pt-PT, pt-BR, es, fr, de.
- nutritionPer100 must be realistic and represent the ingredient per 100 g or 100 ml.
- defaultServing must be a realistic usual serving for one serving of that ingredient.
- resolvedQuantity must represent the amount described in sourceText:
  - if sourceText gives an explicit weight/volume, keep that amount;
  - if sourceText gives a count (for example 1 yogurt), convert it into the usual serving amount;
  - if sourceText gives no quantity, use the usual serving amount.
- Keep units sensible and compatible with nutritionPer100.
- Confidence should be between 0 and 1.
- The output should be strong enough to satisfy automatic catalog promotion rules:
  - all locales present
  - nutrition values finite and realistic
  - macro calories roughly match calories
  - serving quantity reasonable

Return one object per input item, in the same order, with matching sourceText.

Input items:
${JSON.stringify(ingredients, null, 2)}

Return only valid JSON.
`;

    let raw = await requestStructuredJsonCompletion({
      schemaName: "ingredient_catalog_resolution",
      schema,
      temperature: 0.2,
      timeoutMs: 15000,
      messages: [
        {
          role: "system",
          content:
            `You are a food ingredient catalog assistant. Return only valid JSON. The app language is ${language}, but canonicalName must still be English. Aliases must cover en, pt-PT, pt-BR, es, fr, and de. Favor realistic supermarket/nutrition database conventions.`,
        },
        { role: "user", content: prompt },
      ],
    });

    raw = cleanJsonResponse(raw);
    const parsed = safeJSONParse(raw, {});
    const aiItems = Array.isArray(parsed?.items) ? parsed.items : [];

    const db = _adminInitialized ? getAnalyticsDb() : null;
    const authCtx = await getEconomyAuthContext(req).catch(() => ({ uid: null }));
    const resolved = [];

    for (const item of aiItems) {
      const candidate = {
        canonicalName: item?.canonicalName,
        category: item?.category ?? null,
        aliases: item?.aliases || {},
        nutritionPer100: item?.nutritionPer100 || null,
        defaultServing: item?.defaultServing || null,
        sourceText: item?.sourceText || null,
        confidence: item?.confidence ?? null,
        createdAt: Date.now(),
      };

      let persisted = null;
      if (db) {
        persisted = await persistIngredientCatalogCandidate({
          db,
          candidate,
          submittedByUid: authCtx?.uid || null,
        });
      } else {
        const scored = shouldAutoPromoteCandidate(candidate);
        persisted = {
          candidateId: null,
          scored,
          item: null,
          localEntry: serializeIngredientCatalogItem(
            `candidate_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            {
              canonicalName: normalizeAlias(candidate.canonicalName || ""),
              category: candidate.category ?? null,
              aliases: scored.normalized.aliases,
              nutritionPer100: scored.normalized.nutritionPer100,
              defaultServing: scored.normalized.defaultServing,
              source: "ai_resolved",
              updatedAt: Date.now(),
            }
          ),
        };
      }

      resolved.push({
        sourceText: item?.sourceText || candidate.sourceText || "",
        resolvedQuantity: item?.resolvedQuantity || persisted.localEntry?.defaultServing || null,
        confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : null,
        autoPromotion: {
          shouldPromote: !!persisted.scored?.shouldPromote,
          score: persisted.scored?.score ?? 0,
          reasons: persisted.scored?.reasons ?? [],
        },
        localEntry: persisted.localEntry,
        item: persisted.item,
      });
    }

    return res.json({ ok: true, items: resolved });
  } catch (err) {
    console.error("❌ /ingredients/catalog/resolve error:", err?.message || err);
    return res.status(500).json({ error: "Failed to resolve ingredient catalog entries" });
  }
});

// ---------------- Cookbooks Sync Endpoints ----------------

// Legacy client compatibility:
// CookbookSync currently calls POST /sync/cookbooks/pull with { uid }
// and POST /sync/cookbooks/push with { uid, items }.
// These endpoints adapt that shape to the newer Firestore layout, using
// users/{uid}/cookbooks/{cookbookId} as the storage path.

/**
 * POST /sync/cookbooks/pull
 * Body: { uid: string }
 * Returns: { items: CookbookDoc[] }
 */
app.post("/sync/cookbooks/pull", async (req, res) => {
  try {
    console.log("[/sync/cookbooks/pull] called with body:", req.body);
    if (!_adminInitialized) {
      console.error("[/sync/cookbooks/pull] Admin SDK not initialized");
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    const authResolution = await resolveLegacySyncUid(req);
    if (!authResolution.ok || !authResolution.uid) {
      return res
        .status(authResolution.status || 401)
        .json({ error: authResolution.error || "Unauthorized" });
    }
    const uid = authResolution.uid;

    const db = getAnalyticsDb();
    const collectionRef = db.collection(`users/${uid}/cookbooks`);
    const snap = await collectionRef.get();

    const items = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};

      // Normalize updatedAt to a number when possible
      if (typeof data.updatedAt === "string") {
        const num = Number(data.updatedAt);
        if (Number.isFinite(num)) {
          data.updatedAt = num;
        }
      }

      items.push({
        id: doc.id,
        ...data,
      });
    });

    // Optional analytics event
    try {
      const ctx = getEventContext(req);
      trackEvent("sync_cookbooks_pull_legacy", {
        userId: uid,
        deviceId: ctx.deviceId,
        metadata: {
          count: items.length,
          authSource: authResolution.source,
          fallbackUsed: !!authResolution.fallbackUsed,
        },
      });
    } catch (e) {
      console.warn(
        "[/sync/cookbooks/pull] analytics log failed:",
        e?.message || e
      );
    }

    console.log("[/sync/cookbooks/pull] returning items count:", items.length, "for uid:", uid);
    return res.json({ items });
  } catch (err) {
    console.error("❌ /sync/cookbooks/pull error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load cookbooks" });
  }
});

/**
 * POST /sync/cookbooks/push
 * Body: { uid: string, items: CookbookDoc[] }
 * Writes to: users/{uid}/cookbooks/{id}
 */
app.post("/sync/cookbooks/push", async (req, res) => {
  try {
    console.log("[/sync/cookbooks/push] called", {
      uid: req.body && req.body.uid,
      itemsCount: Array.isArray(req.body && req.body.items) ? req.body.items.length : 0,
    });
    if (!_adminInitialized) {
      console.error("[/sync/cookbooks/push] Admin SDK not initialized");
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    const authResolution = await resolveLegacySyncUid(req);
    if (!authResolution.ok || !authResolution.uid) {
      return res
        .status(authResolution.status || 401)
        .json({ error: authResolution.error || "Unauthorized" });
    }
    const uid = authResolution.uid;

    const body = req.body || {};

    const items = Array.isArray(body.items) ? body.items : [];

    // Helper: best-effort detection of default/system cookbooks.
    // We MUST avoid charging cookies for default/built-in cookbooks.
    // This is intentionally conservative: if a cookbook looks like default/system, it is treated as free.
    function isDefaultOrSystemCookbook(raw, id) {
      try {
        if (!raw || typeof raw !== "object") return false;
        const r = raw;

        // Explicit flags (preferred)
        if (r.isDefault === true) return true;
        if (r.isSystem === true) return true;
        if (r.isBuiltin === true) return true;
        if (r.builtIn === true) return true;
        if (r.system === true) return true;

        // Source markers
        if (typeof r.source === "string") {
          const s = r.source.toLowerCase();
          if (s === "default" || s === "builtin" || s === "built-in" || s === "system") return true;
        }

        // Owner markers
        if (typeof r.owner === "string") {
          const o = r.owner.toLowerCase();
          if (o === "system" || o === "default") return true;
        }

        // ID heuristics (very conservative)
        const sid = String(id || "").toLowerCase();
        if (sid.startsWith("default_") || sid.startsWith("builtin_") || sid.startsWith("system_")) return true;

        return false;
      } catch {
        return false;
      }
    }

    // Normalize incoming items first (so we don't duplicate normalization logic inside the transaction)
    const now = Date.now();
    const normalized = [];

    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const anyRaw = raw;
      const id =
        typeof anyRaw.id === "string" && anyRaw.id.trim()
          ? anyRaw.id.trim()
          : typeof anyRaw.docId === "string" && anyRaw.docId.trim()
          ? anyRaw.docId.trim()
          : null;

      if (!id) continue;

      const data = { ...anyRaw };

      // Normalize timestamps
      data.updatedAt =
        typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)
          ? data.updatedAt
          : now;

      if (typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)) {
        data.createdAt =
          typeof anyRaw.createdAt === "number" && Number.isFinite(anyRaw.createdAt)
            ? anyRaw.createdAt
            : now;
      }

      data._serverUpdatedAt = admin.firestore.FieldValue.serverTimestamp();

      // Remove id/docId from document body
      delete data.id;
      delete data.docId;

      normalized.push({ id, raw: anyRaw, data });
    }

    const db = getAnalyticsDb();

    // If there are no valid items, keep existing behavior and return ok.
    if (normalized.length === 0) {
      console.log("[/sync/cookbooks/push] no valid items; returning ok", { uid });
      return res.json({ ok: true, upserted: 0, charged: 0 });
    }

    // Economy enforcement should be per-uid.
    // Keep x-user-id populated for downstream compatibility, but the actual uid
    // above now prefers the verified Firebase token.
    req.headers["x-user-id"] = uid;

    // Perform writes (and cookie charging) in a single Firestore transaction to:
    // - avoid double-charging on retries
    // - ensure atomicity between charging and creating a new cookbook
    let txResult = {
      upserted: 0,
      charged: 0,
      skippedEconomy: true,
      remaining: null,
    };

    await db.runTransaction(async (tx) => {
      // IMPORTANT (Firestore): all reads must happen before any writes.
      // We therefore:
      // 1) read existing cookbooks (for custom count)
      // 2) read existing docs for each incoming item (to know which are new)
      // 3) read economy doc (optional)
      // 4) compute charges
      // 5) perform writes

      // 1) Determine current number of CUSTOM cookbooks on server.
      // We treat default/system cookbooks as free and do not count them against the free limit.
      let existingCustomCount = 0;
      let existingCookbooksSnap = null;
      try {
        const colRef = db.collection(`users/${uid}/cookbooks`);
        existingCookbooksSnap = await tx.get(colRef);
        existingCookbooksSnap.forEach((d) => {
          const v = d.data() || {};
          const looksDefault = isDefaultOrSystemCookbook(v, d.id);
          if (!looksDefault) existingCustomCount += 1;
        });
      } catch (e) {
        // If anything goes wrong counting, fail open for economy (but still proceed with writes)
        existingCustomCount = 0;
      }

      // 2) Read existing docs for each incoming item so we can decide which are NEW.
      // (All reads up-front. No writes yet.)
      const readStates = [];
      for (const item of normalized) {
        const docRef = db.doc(`users/${uid}/cookbooks/${item.id}`);
        const existingSnap = await tx.get(docRef);
        const isNew = !existingSnap.exists;
        const looksDefault = isDefaultOrSystemCookbook(item.raw, item.id);
        readStates.push({ item, docRef, isNew, looksDefault });
      }

      // 3) Optionally read economy doc (fail open by design)
      let economy = null;
      if (ECONOMY_ENABLED && _adminInitialized) {
        try {
          const { ref, data } = await getOrInitEconomyDocTx(tx, db, uid);
          economy = {
            ref,
            cookies:
              typeof data.cookies === "number" && Number.isFinite(data.cookies)
                ? data.cookies
                : 0,
          };
        } catch {
          economy = null;
        }
      }

      // 4) Cookbooks are always free. We still run the transaction so the write path stays atomic.

      // 5) Perform cookbook writes
      for (const st of readStates) {
        tx.set(st.docRef, st.item.data, { merge: true });
        txResult.upserted += 1;
      }
    });

    // Optional analytics event (kept, but extended)
    try {
      const ctx = getEventContext(req);
      trackEvent("sync_cookbooks_push_legacy", {
        userId: uid,
        deviceId: ctx.deviceId,
        metadata: {
          upserted: txResult.upserted,
          charged: txResult.charged,
          skippedEconomy: !!txResult.skippedEconomy,
          remainingCookies: txResult.remaining,
          authSource: authResolution.source,
          fallbackUsed: !!authResolution.fallbackUsed,
        },
      });
    } catch (e) {
      console.warn(
        "[/sync/cookbooks/push] analytics log failed:",
        e?.message || e
      );
    }

    console.log("[/sync/cookbooks/push] write OK", {
      uid,
      upserted: txResult.upserted,
      charged: txResult.charged,
      remaining: txResult.remaining,
      skippedEconomy: !!txResult.skippedEconomy,
    });
    return res.json({
      ok: true,
      upserted: txResult.upserted,
      charged: txResult.charged,
      remaining: txResult.remaining,
      skippedEconomy: !!txResult.skippedEconomy,
    });
  } catch (err) {
    // Translate our transaction error to a stable HTTP status for the client.
    console.error("❌ /sync/cookbooks/push error:", err?.message || err);
    return res.status(500).json({ error: "Failed to save cookbooks" });
  }
});

// ---------------- Recipes Sync Endpoints ----------------
// Legacy client compatibility:
// RecipeSync currently calls POST /sync/recipes/pull with { uid }
// and POST /sync/recipes/push with { uid, items }.
// These endpoints adapt that shape to the Firestore layout, using
// users/{uid}/recipes/{recipeId} as the storage path.

/**
 * POST /sync/recipes/pull
 * Body: { uid: string }
 * Returns: { items: RecipeDoc[] }
 */
app.post("/sync/recipes/pull", async (req, res) => {
  try {
    console.log("[/sync/recipes/pull] called with body:", req.body);
    if (!_adminInitialized) {
      console.error("[/sync/recipes/pull] Admin SDK not initialized");
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    const authResolution = await resolveLegacySyncUid(req);
    if (!authResolution.ok || !authResolution.uid) {
      return res
        .status(authResolution.status || 401)
        .json({ error: authResolution.error || "Unauthorized" });
    }
    const uid = authResolution.uid;

    const db = getAnalyticsDb();
    const collectionRef = db.collection(`users/${uid}/recipes`);
    const snap = await collectionRef.get();

    const items = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};

      // Normalize updatedAt to a number when possible
      if (typeof data.updatedAt === "string") {
        const num = Number(data.updatedAt);
        if (Number.isFinite(num)) {
          data.updatedAt = num;
        }
      }

      items.push({
        id: doc.id,
        ...data,
      });
    });
    console.log("[/sync/recipes/pull] returning items count:", items.length, "for uid:", uid);
    // Optional analytics event
    try {
      const ctx = getEventContext(req);
      trackEvent("sync_recipes_pull_legacy", {
        userId: uid,
        deviceId: ctx.deviceId,
        metadata: {
          count: items.length,
          authSource: authResolution.source,
          fallbackUsed: !!authResolution.fallbackUsed,
        },
      });
    } catch (e) {
      console.warn(
        "[/sync/recipes/pull] analytics log failed:",
        e?.message || e
      );
    }

    return res.json({ items });
  } catch (err) {
    console.error("❌ /sync/recipes/pull error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load recipes" });
  }
});

/**
 * POST /sync/recipes/push
 * Body: { uid: string, items: RecipeDoc[] }
 * Writes to: users/{uid}/recipes/{id}
 * If an item has isDeleted === true, the document is deleted and associated images are removed.
 */
app.post("/sync/recipes/push", async (req, res) => {
  try {
    console.log("[/sync/recipes/push] called with body:", {
      uid: req.body && req.body.uid,
      itemsCount: Array.isArray(req.body && req.body.items) ? req.body.items.length : 0,
    });
    if (!_adminInitialized) {
      console.error("[/sync/recipes/push] Admin SDK not initialized");
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    const authResolution = await resolveLegacySyncUid(req);
    if (!authResolution.ok || !authResolution.uid) {
      return res
        .status(authResolution.status || 401)
        .json({ error: authResolution.error || "Unauthorized" });
    }
    const uid = authResolution.uid;

    const body = req.body || {};

    const items = Array.isArray(body.items) ? body.items : [];
    req.headers["x-user-id"] = uid;

    const db = getAnalyticsDb();
    const batch = db.batch();
    const now = Date.now();

    let upsertedCount = 0;
    let deletedCount = 0;

    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const anyRaw = raw;
      const id =
        typeof anyRaw.id === "string" && anyRaw.id.trim()
          ? anyRaw.id.trim()
          : typeof anyRaw.docId === "string" && anyRaw.docId.trim()
          ? anyRaw.docId.trim()
          : null;

      if (!id) continue;

      const docRef = db.doc(`users/${uid}/recipes/${id}`);
      // --- Insert debug log for docRef path, isDeleted, and hasImageUrl ---
      console.log("[/sync/recipes/push] upserting doc", {
        path: docRef.path,
        isDeleted: anyRaw.isDeleted === true,
        hasImageUrl: typeof anyRaw.image === "string" && anyRaw.image.length > 0,
      });

      // If marked as deleted, delete doc and associated images
      if (anyRaw.isDeleted === true) {
        batch.delete(docRef);
        deletedCount += 1;

        // Best-effort deletion of associated images (ignore errors)
        try {
          await deleteRecipeImages(uid, id);
        } catch (e) {
          console.warn(
            "[/sync/recipes/push] deleteRecipeImages failed:",
            e?.message || e
          );
        }

        continue;
      }

      const data = { ...anyRaw };

      // Normalize timestamps
      data.updatedAt =
        typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)
          ? data.updatedAt
          : now;

      if (
        typeof data.createdAt !== "number" ||
        !Number.isFinite(data.createdAt)
      ) {
        data.createdAt =
          typeof anyRaw.createdAt === "number" &&
          Number.isFinite(anyRaw.createdAt)
            ? anyRaw.createdAt
            : now;
      }

      data._serverUpdatedAt = admin.firestore.FieldValue.serverTimestamp();

      // Remove id/docId from document body
      delete data.id;
      delete data.docId;

      batch.set(docRef, data, { merge: true });
      upsertedCount += 1;
    }
    console.log("[/sync/recipes/push] processed items. upsertedCount:", upsertedCount, "deletedCount:", deletedCount, "for uid:", uid);

    await batch.commit();
    console.log("[/sync/recipes/push] batch commit successful for uid:", uid);

    // Optional analytics event
    try {
      const ctx = getEventContext(req);
      trackEvent("sync_recipes_push_legacy", {
        userId: uid,
        deviceId: ctx.deviceId,
        metadata: {
          upserted: upsertedCount,
          deleted: deletedCount,
          authSource: authResolution.source,
          fallbackUsed: !!authResolution.fallbackUsed,
        },
      });
    } catch (e) {
      console.warn(
        "[/sync/recipes/push] analytics log failed:",
        e?.message || e
      );
    }

    return res.json({ ok: true, upserted: upsertedCount, deleted: deletedCount });
  } catch (err) {
    console.error("❌ /sync/recipes/push error:", err?.message || err);
    return res.status(500).json({ error: "Failed to save recipes" });
  }
});

// These endpoints are used by the mobile app to synchronize user recipes
// between AsyncStorage on the device and Firestore under:
//   users/{uid}/recipes/{recipeId}
app.get("/sync/recipes", async (req, res) => {
  try {
    if (!_adminInitialized) {
      console.error("[/sync/recipes] Admin SDK not initialized");
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    let decoded;
    try {
      decoded = await verifyIdTokenFromHeader(req);
    } catch (e) {
      console.error("[/sync/recipes] Token verification failed:", e?.message || e);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const uid = decoded && decoded.uid;
    if (!uid) {
      return res.status(400).json({ error: "Missing user id" });
    }

    const db = getAnalyticsDb();
    const collectionRef = db.collection(`users/${uid}/recipes`);
    const snap = await collectionRef.get();

    const docs = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};

      // Normalize updatedAt to a number when possible
      if (typeof data.updatedAt === "string") {
        const num = Number(data.updatedAt);
        if (Number.isFinite(num)) {
          data.updatedAt = num;
        }
      }

      docs.push({
        id: doc.id,
        ...data,
      });
    });

    // Optional analytics event
    try {
      const ctx = getEventContext(req);
      trackEvent("sync_recipes_read", {
        userId: uid,
        deviceId: ctx.deviceId,
        metadata: {
          count: docs.length,
        },
      });
    } catch (e) {
      console.warn("[/sync/recipes] analytics log failed:", e?.message || e);
    }

    return res.json({ docs });
  } catch (err) {
    console.error("❌ /sync/recipes (GET) error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load recipes" });
  }
});

app.post("/sync/recipes", async (req, res) => {
  try {
    if (!_adminInitialized) {
      console.error("[/sync/recipes] Admin SDK not initialized");
      return res.status(500).json({ error: "Admin SDK not initialized" });
    }

    let decoded;
    try {
      decoded = await verifyIdTokenFromHeader(req);
    } catch (e) {
      console.error("[/sync/recipes] Token verification failed:", e?.message || e);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const uid = decoded && decoded.uid;
    if (!uid) {
      return res.status(400).json({ error: "Missing user id" });
    }

    const body = req.body || {};
    const docs = Array.isArray(body.docs) ? body.docs : [];
    const deletedIds = Array.isArray(body.deletedIds) ? body.deletedIds : [];

    const db = getAnalyticsDb();
    const batch = db.batch();
    const now = Date.now();

    // Upsert recipes
    for (const raw of docs) {
      if (!raw || typeof raw !== "object") continue;
      const id =
        typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null;
      if (!id) continue;

      const data = { ...raw };

      // Normalize timestamps
      data.updatedAt =
        typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)
          ? data.updatedAt
          : now;

      if (
        typeof data.createdAt !== "number" ||
        !Number.isFinite(data.createdAt)
      ) {
        data.createdAt =
          typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
            ? raw.createdAt
            : now;
      }

      data._serverUpdatedAt = admin.firestore.FieldValue.serverTimestamp();

      // Do not keep id inside the document body
      delete data.id;

      const docRef = db.doc(`users/${uid}/recipes/${id}`);
      batch.set(docRef, data, { merge: true });
    }

    // Delete recipes (and associated images in Storage)
    for (const rawId of deletedIds) {
      const id =
        typeof rawId === "string" && rawId.trim() ? rawId.trim() : null;
      if (!id) continue;
      const docRef = db.doc(`users/${uid}/recipes/${id}`);
      batch.delete(docRef);

      // Best-effort deletion of associated images (ignore errors)
      try {
        await deleteRecipeImages(uid, id);
      } catch (e) {
        console.warn("[/sync/recipes] deleteRecipeImages failed:", e?.message || e);
      }
    }

    await batch.commit();

    // Optional analytics event
    try {
      const ctx = getEventContext(req);
      trackEvent("sync_recipes_write", {
        userId: uid,
        deviceId: ctx.deviceId,
        metadata: {
          upserted: docs.length,
          deleted: deletedIds.length,
        },
      });
    } catch (e) {
      console.warn("[/sync/recipes] analytics log failed:", e?.message || e);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /sync/recipes (POST) error:", err?.message || err);
    return res.status(500).json({ error: "Failed to save recipes" });
  }
});

// Serve frontend assets (for default_recipe.png, etc)
app.use("/assets", express.static(path.resolve(__dirname, "../frontend/RecipeAI/assets")));

const upload = multer({ storage: multer.memoryStorage() });
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: getSupportedImportFormats().maxFileSizeBytes,
    files: 1,
  },
});

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

app.post("/analyzeMealPhoto", upload.single("image"), async (req, res) => {
  try {
    validateUploadedImage(req.file);

    const language = normalizeLanguage(req.body?.language);
    const mimeType = req.file.mimetype || "image/jpeg";
    const base64 = req.file.buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["isFood", "confidence", "title", "ingredients", "nutrition"],
      properties: {
        isFood: { type: "boolean" },
        confidence: { type: "number" },
        title: { type: "string" },
        ingredients: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "quantity", "unit"],
            properties: {
              name: { type: "string" },
              quantity: { type: "number" },
              unit: { type: "string", enum: ["g", "kg", "ml", "l", "tbsp", "tsp", "un"] },
            },
          },
        },
        nutrition: {
          type: "object",
          additionalProperties: false,
          required: ["calories", "protein", "carbs", "fat"],
          properties: {
            calories: { type: "number" },
            protein: { type: "number" },
            carbs: { type: "number" },
            fat: { type: "number" },
          },
        },
      },
    };

    const prompt = `
Analyze this image for meal logging.

Rules:
- First decide whether this is clearly a food/meal image.
- If it is not food, return isFood=false, confidence, an empty ingredients array, and zero nutrition values.
- If it is food:
  - identify only the main ingredients that materially affect calories/macros;
  - avoid garnish, tiny spices, and decorative elements unless they clearly matter;
  - estimate one realistic quantity per visible main ingredient;
  - use units only from: g, kg, ml, l, tbsp, tsp, un;
  - estimate total nutrition for the pictured meal as served in the photo;
  - title should be a short natural meal title in the user's language (${language}).

Return only valid JSON.
`;

    let raw = "";
    try {
      const completion = await withTimeout(
        client.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.2,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "meal_photo_analysis",
              schema,
              strict: true,
            },
          },
          messages: [
            {
              role: "system",
              content: `You are a nutrition assistant for a meal logging app. Respond only with valid JSON. The user language is ${language}.`,
            },
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        20000
      );
      raw = completion.choices[0]?.message?.content?.trim() || "";
    } catch (err) {
      console.warn("[/analyzeMealPhoto] structured vision failed, retrying plain JSON:", err?.message || err);
      const completion = await withTimeout(
        client.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: `You are a nutrition assistant for a meal logging app. Respond only with valid JSON. The user language is ${language}.`,
            },
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        20000
      );
      raw = completion.choices[0]?.message?.content?.trim() || "";
    }

    const parsed = safeJSONParse(cleanJsonResponse(raw), null);
    const isFood = parsed?.isFood === true;
    let ingredients = Array.isArray(parsed?.ingredients)
      ? parsed.ingredients
          .map((item) => ({
            name: String(item?.name || "").trim().slice(0, 80),
            quantity: Number(item?.quantity),
            unit: String(item?.unit || "").trim().toLowerCase(),
          }))
          .filter(
            (item) =>
              item.name &&
              Number.isFinite(item.quantity) &&
              item.quantity > 0 &&
              ["g", "kg", "ml", "l", "tbsp", "tsp", "un"].includes(item.unit)
          )
          .slice(0, 10)
      : [];

    const nutrition = {
      calories: Math.max(0, Math.round(Number(parsed?.nutrition?.calories) || 0)),
      protein: Math.max(0, Math.round(Number(parsed?.nutrition?.protein) || 0)),
      carbs: Math.max(0, Math.round(Number(parsed?.nutrition?.carbs) || 0)),
      fat: Math.max(0, Math.round(Number(parsed?.nutrition?.fat) || 0)),
    };

    return res.json({
      ok: true,
      analysis: {
        isFood,
        confidence: Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : 0,
        title: String(parsed?.title || "").trim(),
        ingredients: isFood ? ingredients : [],
        nutrition: isFood ? nutrition : { calories: 0, protein: 0, carbs: 0, fat: 0 },
      },
    });
  } catch (err) {
    const status = err?.statusCode || 500;
    console.error("❌ /analyzeMealPhoto error:", err?.message || err);
    return res.status(status).json({ error: err?.message || "Failed to analyze meal photo" });
  }
});

app.post("/meals/text/resolve", async (req, res) => {
  try {
    const input = sanitizeInput(req.body?.input || "");
    const language = normalizeLanguage(req.body?.language);
    const parsedIngredients = Array.isArray(req.body?.parsedIngredients)
      ? req.body.parsedIngredients
          .map((item) => ({
            name: sanitizeInput(item?.name || ""),
            quantity: Number(item?.quantity),
            unit: sanitizeInput(item?.unit || ""),
          }))
          .filter((item) => item.name)
          .slice(0, 10)
      : [];

    if (!input) {
      return res.status(400).json({ error: "Meal description is required" });
    }

    const cacheKey = normalizeMealTextResolveCacheKey(input, language);
    const cached = getMealTextResolveCache(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["title", "ingredients", "nutrition", "confidence"],
      properties: {
        title: { type: "string" },
        ingredients: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "quantity", "unit"],
            properties: {
              name: { type: "string" },
              quantity: { type: "number" },
              unit: { type: "string", enum: ["g", "ml"] },
            },
          },
        },
        nutrition: {
          type: "object",
          additionalProperties: false,
          required: ["calories", "protein", "carbs", "fat"],
          properties: {
            calories: { type: "number" },
            protein: { type: "number" },
            carbs: { type: "number" },
            fat: { type: "number" },
          },
        },
        confidence: { type: "number" },
      },
    };

    const prompt = `
Resolve this user-described meal for a meal tracking app.

Language: ${language}
Description: ${input}
Parser first-pass:
${JSON.stringify(parsedIngredients, null, 2)}

Goal:
- Return the best user-facing meal logging representation and total nutrition.
- Treat this as MealPhraseRules: decide whether the phrase is one prepared food/product or separable foods.
- Use ingredient names in the user's language when possible.
- Use only g or ml.
- Preserve explicit quantities from the user.
- If quantity is missing, infer realistic one-person eating quantities.
- For counted foods without grams/ml, convert the count into edible weight/volume. For example, "2 pães" means two bread portions/rolls, not 2 grams.
- A normal serving of soup is usually around 250-350 ml; a normal serving of lasagna or a similar prepared main dish is usually around 250-350 g.
- Do NOT decompose prepared dishes/products into full recipes.
- Split only separable foods eaten together.

Important examples:
- "Pão com fiambre" => Pão + Fiambre.
- "Iogurte com granola" => Iogurte + Granola.
- "Leite achocolatado" => one item: Leite achocolatado.
- "Bolo de cenoura" => one item: Bolo de cenoura.
- "Bolo de cenoura com queijo" => Bolo de cenoura + Queijo.
- "Hamburger with breaded chicken, salad, strawberries, chickpeas and low-fat yogurt" => Breaded chicken burger + Salad + Strawberries + Chickpeas + Low-fat yogurt.
- "Lasanha de atum" => one item: Lasanha de atum.
- "Lasanha de atum" quantity should be a normal main-dish serving, about 250-350 g, not a small tasting portion.
- "100g de Bolo de cenoura" => one item: Bolo de cenoura, 100 g.
- "2 Pães com fiambre" => Pão quantity for 2 breads + Fiambre quantity for 2 servings.
- "Sopa de legumes" => one item: Sopa de legumes.

Decision rule:
- "de/of/achocolatado/grego/magro/panado/recheado" often describes the food type; keep it attached.
- "com/with/con/avec/mit" can separate foods only when both sides are independent foods.
- For burger/hamburger phrases, "with + protein/preparation" usually describes the burger filling; keep it as one burger item. Sides after commas or "and" stay separate.
- If uncertain, prefer fewer clearer items over too many recipe sub-ingredients.
- Total nutrition must match the returned ingredient representation.

Return valid JSON only.
`;

    let raw = await requestStructuredJsonCompletion({
      schemaName: "meal_text_resolution",
      schema,
      temperature: 0.1,
      timeoutMs: 12000,
      messages: [
        {
          role: "system",
          content:
            "You resolve natural-language meal descriptions for a nutrition app. Be practical, conservative, multilingual, and avoid over-decomposition.",
        },
        { role: "user", content: prompt },
      ],
    });

    raw = cleanJsonResponse(raw);
    const parsed = safeJSONParse(raw, {});
    let ingredients = Array.isArray(parsed?.ingredients)
      ? parsed.ingredients
          .map((item) => {
            const clamped = clampMealTextResolvedQuantity(item, input);
            return {
              name: sanitizeInput(item?.name || "").slice(0, 80),
              quantity: clamped ? Math.round(clamped.quantity * 10) / 10 : NaN,
              unit: clamped?.unit || String(item?.unit || "").toLowerCase(),
            };
          })
          .filter(
            (item) =>
              item.name &&
              Number.isFinite(item.quantity) &&
              item.quantity > 0 &&
              ["g", "ml"].includes(item.unit)
          )
          .slice(0, 8)
      : [];

    const normalizedIngredientText = (value) =>
      String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    const hasProteinShake = ingredients.some((item) =>
      /\b(protein shake|shake de proteina|batido de proteina|shake proteine|proteinshake)\b/.test(
        normalizedIngredientText(item.name)
      )
    );
    const hasProteinShakeComponents = ingredients.some((item) =>
      /\b(milk|leite|leche|lait|milch|banana|platano|banane|peanut butter|manteiga de amendoim|pasta de amendoim|beurre de cacahuete|erdnussbutter)\b/.test(
        normalizedIngredientText(item.name)
      )
    );
    if (hasProteinShake && hasProteinShakeComponents) {
      const powderName =
        language === "pt-BR" || language === "pt-PT"
          ? "Proteína em pó"
          : language === "es"
            ? "Proteína en polvo"
            : language === "fr"
              ? "Protéine en poudre"
              : language === "de"
                ? "Proteinpulver"
                : "Protein powder";
      ingredients = ingredients.map((item) =>
        /\b(protein shake|shake de proteina|batido de proteina|shake proteine|proteinshake)\b/.test(
          normalizedIngredientText(item.name)
        )
          ? { name: powderName, quantity: 30, unit: "g" }
          : item
      );
    }
    const inputLooksLikeProteinShake = /\b(protein shake|shake de proteina|batido de proteina|shake proteine|shake proteico|proteinshake)\b/.test(
      normalizedIngredientText(input)
    );
    const hasProteinPowder = ingredients.some((item) =>
      /\b(protein powder|proteina em po|proteina en polvo|proteine en poudre|proteinpulver)\b/.test(
        normalizedIngredientText(item.name)
      )
    );
    const proteinPowderName =
      language === "pt-BR" || language === "pt-PT"
        ? "Proteína em pó"
        : language === "es"
          ? "Proteína en polvo"
          : language === "fr"
            ? "Protéine en poudre"
            : language === "de"
              ? "Proteinpulver"
              : "Protein powder";
    if (inputLooksLikeProteinShake && hasProteinShakeComponents && !hasProteinPowder) {
      ingredients = [{ name: proteinPowderName, quantity: 30, unit: "g" }, ...ingredients].slice(0, 8);
    }
    if (inputLooksLikeProteinShake && !hasProteinShakeComponents) {
      const normalizedInput = normalizedIngredientText(input);
      const shakeIngredients = [{ name: proteinPowderName, quantity: 30, unit: "g" }];
      if (/\b(milk|leite|leche|lait|milch)\b/.test(normalizedInput)) {
        shakeIngredients.push({
          name:
            language === "pt-BR" || language === "pt-PT"
              ? "Leite"
              : language === "es"
                ? "Leche"
                : language === "fr"
                  ? "Lait"
                  : language === "de"
                    ? "Milch"
                    : "Milk",
          quantity: 200,
          unit: "ml",
        });
      }
      if (/\b(banana|platano|banane)\b/.test(normalizedInput)) {
        shakeIngredients.push({ name: "Banana", quantity: 120, unit: "g" });
      }
      if (/\b(pb|peanut butter|manteiga de amendoim|pasta de amendoim|beurre de cacahuete|erdnussbutter)\b/.test(normalizedInput)) {
        shakeIngredients.push({
          name:
            language === "pt-BR" || language === "pt-PT"
              ? "Manteiga de amendoim"
              : language === "es"
                ? "Mantequilla de cacahuete"
                : language === "fr"
                  ? "Beurre de cacahuète"
                  : language === "de"
                    ? "Erdnussbutter"
                    : "Peanut butter",
          quantity: 16,
          unit: "g",
        });
      }
      ingredients = shakeIngredients;
    }

    const nutrition = {
      calories: Math.max(0, Math.round(Number(parsed?.nutrition?.calories) || 0)),
      protein: Math.max(0, Math.round(Number(parsed?.nutrition?.protein) || 0)),
      carbs: Math.max(0, Math.round(Number(parsed?.nutrition?.carbs) || 0)),
      fat: Math.max(0, Math.round(Number(parsed?.nutrition?.fat) || 0)),
    };

    if (ingredients.length === 0 || nutrition.calories <= 0) {
      return res.status(500).json({ error: "Failed to resolve meal description" });
    }

    const result = {
      ok: true,
      title: sanitizeInput(parsed?.title || input),
      ingredients,
      nutrition,
      confidence: Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : null,
    };

    setMealTextResolveCache(cacheKey, result);
    persistMealPhraseRuleCandidate({
      input,
      language,
      parsedIngredients,
      result,
    }).catch((candidateErr) => {
      console.warn("⚠️ Failed to persist meal phrase candidate:", candidateErr?.message || candidateErr);
    });

    return res.json(result);
  } catch (err) {
    console.error("❌ /meals/text/resolve error:", err?.message || err);
    return res.status(500).json({ error: "Failed to resolve meal description" });
  }
});

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

// Backend environment tag for analytics (_env in metadata)
// You can override this via BACKEND_ENV (e.g. "local", "preview", "production").
const RAW_BACKEND_ENV = process.env.BACKEND_ENV || process.env.NODE_ENV || "local";

let ANALYTICS_ENV = "local-backend";
if (RAW_BACKEND_ENV === "preview") {
  ANALYTICS_ENV = "preview-backend";
} else if (RAW_BACKEND_ENV === "production") {
  ANALYTICS_ENV = "production-backend";
} else if (RAW_BACKEND_ENV === "development") {
  ANALYTICS_ENV = "local-backend";
} else if (RAW_BACKEND_ENV && RAW_BACKEND_ENV !== "local") {
  // Any custom value, keep it but add "-backend" suffix for consistency
  ANALYTICS_ENV = `${RAW_BACKEND_ENV}-backend`;
}

let _firestoreClient = null;
function getAnalyticsDb() {
  // Lazily create a Firestore client that points to the desired database ID.
  // If FIREBASE_DATABASE_ID === "(default)", we use the default database.
  if (!_firestoreClient) {
    const options = { projectId: PROJECT_ID };

    if (FIRESTORE_DB_ID && FIRESTORE_DB_ID !== "(default)") {
      options.databaseId = FIRESTORE_DB_ID;
    }

    _firestoreClient = new Firestore(options);
  }
  return _firestoreClient;
}

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

function detectLikelyLanguage(text) {
  if (!text || typeof text !== "string") return null;
  const normalized = text.trim();
  if (normalized.length < 40) return null;

  try {
    const detected = franc(normalized);
    const map = {
      por: "Portuguese",
      spa: "Spanish",
      fra: "French",
      deu: "German",
      ita: "Italian",
      eng: "English",
    };
    return map[detected] || null;
  } catch {
    return null;
  }
}

function isLikelyTargetLanguage(text, targetLang) {
  const detectedLang = detectLikelyLanguage(text);
  if (!detectedLang) return true;

  const detected = detectedLang.toLowerCase();
  const target = String(targetLang || "English").toLowerCase();

  if (target.includes("portuguese")) return detected === "portuguese";
  if (target.includes("spanish")) return detected === "spanish";
  if (target.includes("french")) return detected === "french";
  if (target.includes("german")) return detected === "german";
  if (target.includes("italian")) return detected === "italian";
  return detected === "english";
}

// --- Helper: clean JSON output from OpenAI (strip markdown fences) ---
function cleanJsonResponse(text) {
  if (!text) return "";
  return text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function inferRecipeTitleFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] || segments[segments.length - 2] || "";
    const decoded = decodeURIComponent(last)
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!decoded) return "";
    return decoded.replace(/\b\w/g, (match) => match.toUpperCase());
  } catch {
    return "";
  }
}

function extractQuotedListFromJsonLike(raw, key, nextKeys = []) {
  const text = String(raw || "");
  const keyIndex = text.indexOf(`"${key}"`);
  if (keyIndex === -1) return [];
  const arrayStart = text.indexOf("[", keyIndex);
  if (arrayStart === -1) return [];

  let endIndex = text.indexOf("]", arrayStart);
  if (endIndex === -1) {
    const nextIndices = nextKeys
      .map((nextKey) => text.indexOf(`"${nextKey}"`, arrayStart))
      .filter((index) => index !== -1);
    endIndex = nextIndices.length ? Math.min(...nextIndices) : text.length;
  }

  const slice = text.slice(arrayStart, endIndex);
  return Array.from(slice.matchAll(/"((?:[^"\\]|\\.)*)"/g))
    .map((match) => match[1])
    .map((value) =>
      value
        .replace(/\\"/g, '"')
        .replace(/\\n/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

function recoverRecipeFromJsonLike(raw, fallbackTitle = "") {
  const text = cleanJsonResponse(raw);
  if (!text) return null;

  const titleMatch = text.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const cookingTimeMatch = text.match(/"cookingTime"\s*:\s*(\d+(?:\.\d+)?)/);
  const difficultyMatch = text.match(/"difficulty"\s*:\s*"(Easy|Moderate|Challenging)"/);
  const servingsMatch = text.match(/"servings"\s*:\s*(\d+(?:\.\d+)?)/);
  const costMatch = text.match(/"cost"\s*:\s*"(Cheap|Medium|Expensive)"/);

  const ingredients = extractQuotedListFromJsonLike(text, "ingredients", ["steps", "tags"]);
  const steps = extractQuotedListFromJsonLike(text, "steps", ["tags"]);
  const tags = extractQuotedListFromJsonLike(text, "tags");

  if (!ingredients.length || !steps.length) return null;

  return {
    title:
      (titleMatch?.[1] || "")
        .replace(/\\"/g, '"')
        .trim() || fallbackTitle || "Untitled Recipe",
    cookingTime: cookingTimeMatch ? Number(cookingTimeMatch[1]) : 30,
    difficulty: difficultyMatch?.[1] || "Moderate",
    servings: servingsMatch ? Number(servingsMatch[1]) : 4,
    cost: costMatch?.[1] || "Medium",
    ingredients,
    steps,
    tags,
  };
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

function createAiTimingLogger(scope, meta = {}) {
  const startedAt = Date.now();
  let lastAt = startedAt;

  return {
    mark(stage, extra = {}) {
      const now = Date.now();
      console.log(`[AI Timing] ${scope}:${stage}`, {
        ...meta,
        totalMs: now - startedAt,
        deltaMs: now - lastAt,
        ...extra,
      });
      lastAt = now;
    },
  };
}

async function requestStructuredJsonCompletion({
  schemaName,
  schema,
  messages,
  temperature = 0.7,
  timeoutMs = 10000,
  model = "gpt-4o-mini",
}) {
  try {
    const completion = await withTimeout(
      client.chat.completions.create({
        model,
        messages,
        temperature,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: schemaName,
            schema,
            strict: true,
          },
        },
      }),
      timeoutMs
    );

    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.warn(
      `[AI] Structured output failed for ${schemaName}, falling back to prompt-only JSON:`,
      err?.message || err
    );

    const completion = await withTimeout(
      client.chat.completions.create({
        model,
        messages,
        temperature,
      }),
      timeoutMs
    );

    return completion.choices[0].message.content.trim();
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

function isInstagramReelUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    return host === "instagram.com" && /^\/reel\/[^/]+/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizeSourceUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function normalizeEnumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function extractStructuredJson(rawText, fallback = null) {
  const parsed = safeJSONParse(cleanJsonResponse(rawText), fallback);
  return parsed ?? fallback;
}

function normalizeCaptionLine(line) {
  return String(line || "")
    .replace(/\u2022/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function expandCommonIngredientShorthand(line) {
  let normalized = normalizeCaptionLine(line);
  if (!normalized) return normalized;

  // Common Portuguese shorthand: "q.b." / "qb" = "quanto baste" ("to taste"/"as needed")
  normalized = normalized.replace(/\bq\.?\s*b\.?\b/gi, "quanto baste");

  return normalized;
}

function looksLikeIngredientCaptionLine(line) {
  const normalized = normalizeCaptionLine(line);
  if (!normalized) return false;
  if (normalized.startsWith("#")) return false;
  if (/^(one pot|ingredients?|method|directions?|instructions?|recipe)$/i.test(normalized)) {
    return false;
  }
  if (/^[\w\s!?.:'",()-]+$/.test(normalized) && normalized.split(" ").length <= 4) {
    return /(\d|tbsp|tsp|cup|cups|oz|lb|g|kg|ml|l|clove|cloves|sprig|sprigs|large|small|fresh|pinch|half|¼|½|¾)/i.test(
      normalized
    );
  }
  return /(\d|tbsp|tsp|cup|cups|oz|lb|g|kg|ml|l|clove|cloves|sprig|sprigs|large|small|fresh|pinch|half|¼|½|¾)/i.test(
    normalized
  );
}

function extractIngredientCandidatesFromInstagramCaption(caption) {
  const text = typeof caption === "string" ? caption : "";
  if (!text.trim()) return [];

  const lines = text
    .split(/\n+/)
    .map(normalizeCaptionLine)
    .filter(Boolean);

  const ingredientHeaderIndex = lines.findIndex((line) =>
    /^(ingredients?|ingredientes?|ingredienti|zutaten|ingrédients?)$/i.test(line)
  );
  const processHeaderIndex = lines.findIndex(
    (line, index) =>
      index > ingredientHeaderIndex &&
      /^(processo|method|directions?|instructions?|modo de preparo|preparação|preparo|steps?|modo de fazer|how to make)[:]?$/i.test(
        line
      )
  );

  const scopedLines =
    ingredientHeaderIndex >= 0
      ? lines.slice(
          ingredientHeaderIndex + 1,
          processHeaderIndex >= 0 ? processHeaderIndex : ingredientHeaderIndex + 1 + 40
        )
      : lines;

  return scopedLines
    .map((line) => expandCommonIngredientShorthand(line))
    .filter(
      (line) =>
        !/^(ingredients?|ingredientes?|ingredienti|zutaten|ingrédients?|to assemble|assembly|for the filling|for serving)[:]?$/i.test(
          line
        )
    )
    .filter((line) => looksLikeIngredientCaptionLine(line))
    .filter((line) => !/^#/.test(line))
    .slice(0, 40);
}

function dedupeNormalizedLines(lines) {
  const seen = new Set();
  const result = [];
  for (const rawLine of Array.isArray(lines) ? lines : []) {
    if (typeof rawLine !== "string") continue;
    const line = rawLine.trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }
  return result;
}

async function fetchInstagramReelDataFromApify(url) {
  const token = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN;
  if (!token) {
    const err = new Error("Instagram extractor is not configured.");
    err.statusCode = 500;
    err.code = "INSTAGRAM_EXTRACTOR_NOT_CONFIGURED";
    throw err;
  }

  const actorUrl =
    "https://api.apify.com/v2/acts/apify~instagram-reel-scraper/run-sync-get-dataset-items?timeout=120&maxItems=1&maxTotalChargeUsd=0.02";

  const resp = await fetch(actorUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: [url],
      resultsLimit: 1,
    }),
  });

  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }

  if (!resp.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      "The Instagram Reel could not be accessed.";
    const err = new Error(message);
    err.statusCode = resp.status >= 400 && resp.status < 500 ? 400 : 502;
    err.code = "INSTAGRAM_EXTRACTOR_FAILED";
    throw err;
  }

  const item = Array.isArray(data) ? data[0] : null;
  if (!item || typeof item !== "object") {
    const err = new Error("No Instagram Reel data was returned.");
    err.statusCode = 404;
    err.code = "INSTAGRAM_REEL_NOT_FOUND";
    throw err;
  }

  return item;
}

async function transcribeInstagramAudio(audioUrl) {
  if (!audioUrl || typeof audioUrl !== "string") return "";

  try {
    const response = await fetch(audioUrl, {
      method: "GET",
      timeout: 20000,
      headers: {
        "User-Agent": "CookNEatAI/1.0",
      },
    });

    if (!response.ok) return "";

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > INSTAGRAM_TRANSCRIPTION_MAX_BYTES
    ) {
      return "";
    }

    const buffer = await response.buffer();
    if (!buffer || buffer.length === 0) return "";
    if (buffer.length > INSTAGRAM_TRANSCRIPTION_MAX_BYTES) return "";

    const audioFile = await toFile(
      buffer,
      "instagram-reel-audio.mp4",
      { type: response.headers.get("content-type") || "audio/mp4" }
    );

    const transcript = await client.audio.transcriptions.create({
      file: audioFile,
      model: "gpt-4o-mini-transcribe",
    });

    return typeof transcript?.text === "string" ? transcript.text.trim() : "";
  } catch (err) {
    console.warn("[Instagram Import] audio transcription skipped", {
      message: err?.message || String(err),
    });
    return "";
  }
}

async function buildInstagramRecipeDraft({ reel, measurementSystem }) {
  const captionIngredientCandidates = extractIngredientCandidatesFromInstagramCaption(
    reel?.caption || ""
  );
  const audioTranscript = await transcribeInstagramAudio(reel?.audioUrl || "");
  const prompt = `
You extract structured recipe drafts from Instagram Reels.

Measurement system: ${measurementSystem}

Rules:
- Return ONLY valid JSON.
- If this Reel is not clearly a recipe, set "status" to "failed".
- If recipe information is incomplete but usable, set "status" to "partial".
- If recipe information is sufficient, set "status" to "complete".
- Keep "difficulty" as one of: "Easy", "Moderate", "Challenging".
- Keep "cost" as one of: "Cheap", "Medium", "Expensive".
- Keep title, ingredients, steps, notes, and warnings in the same language as the Reel caption/source content.
- Do not translate the recipe into another language.
- Respect the ${measurementSystem} measurement system and do not mix unit systems.
- Do not invent very specific quantities unless the Reel strongly implies them.
- Prefer returning partial with warnings instead of hallucinating.
- If the caption already contains an ingredient list, preserve all clear ingredient lines instead of summarizing them.
- Use the audio transcript to recover missing preparation steps when the caption only lists ingredients.

Return exactly this JSON shape:
{
  "status": "complete" | "partial" | "failed",
  "title": "string",
  "cookingTime": 0,
  "difficulty": "Easy" | "Moderate" | "Challenging",
  "servings": 0,
  "cost": "Cheap" | "Medium" | "Expensive",
  "ingredients": ["string"],
  "steps": ["string"],
  "tags": ["string"],
  "notes": "string",
  "warnings": ["string"],
  "failureReason": "string",
  "confidence": 0
}

Instagram Reel data:
${JSON.stringify(
    {
      url: reel.url || reel.inputUrl || "",
      caption: reel.caption || "",
      captionIngredientCandidates,
      hashtags: Array.isArray(reel.hashtags) ? reel.hashtags : [],
      ownerUsername: reel.ownerUsername || "",
      ownerFullName: reel.ownerFullName || "",
      firstComment: reel.firstComment || "",
      audioTranscript,
      displayUrl: reel.displayUrl || "",
      videoDuration: reel.videoDuration || null,
      audioUrl: reel.audioUrl || "",
      videoUrl: reel.videoUrl || "",
      productType: reel.productType || "",
    },
    null,
    2
  )}
`;

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You turn social media recipe content into structured recipe drafts. Return JSON only.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content || "";
  const draft = extractStructuredJson(raw, null);

  if (!draft || typeof draft !== "object") {
    const err = new Error("Failed to extract a valid recipe draft.");
    err.statusCode = 502;
    err.code = "INSTAGRAM_DRAFT_PARSE_FAILED";
    throw err;
  }

  if (captionIngredientCandidates.length > 0) {
    const aiIngredients = Array.isArray(draft.ingredients) ? draft.ingredients : [];
    const mergedIngredients = dedupeNormalizedLines([
      ...captionIngredientCandidates,
      ...aiIngredients,
    ]);
    draft.ingredients = mergedIngredients;
  }

  return draft;
}

function normalizeInstagramDraftResponse(draft, reel) {
  const status = ["complete", "partial", "failed"].includes(draft?.status)
    ? draft.status
    : "failed";

  const warnings = Array.isArray(draft?.warnings)
    ? draft.warnings.filter((item) => typeof item === "string" && item.trim())
    : [];

  if (status === "failed") {
    return {
      status,
      warnings,
      failureReason:
        typeof draft?.failureReason === "string" && draft.failureReason.trim()
          ? draft.failureReason.trim()
          : "We could not extract a reliable recipe from this Instagram Reel.",
      recipe: null,
    };
  }

  const ingredients = Array.isArray(draft?.ingredients)
    ? draft.ingredients.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
  const steps = Array.isArray(draft?.steps)
    ? draft.steps.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
  const tags = Array.isArray(draft?.tags)
    ? draft.tags.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()).slice(0, 8)
    : [];

  if (!ingredients.length || !steps.length) {
    return {
      status: "failed",
      warnings,
      failureReason:
        typeof draft?.failureReason === "string" && draft.failureReason.trim()
          ? draft.failureReason.trim()
          : "We could not extract enough recipe information from this Instagram Reel.",
      recipe: null,
    };
  }

  return {
    status,
    warnings,
    failureReason: "",
    recipe: {
      id: `${Date.now()}`,
      title:
        typeof draft?.title === "string" && draft.title.trim()
          ? draft.title.trim()
          : "Imported Instagram Recipe",
      cookingTime:
        typeof draft?.cookingTime === "number" && Number.isFinite(draft.cookingTime)
          ? Math.max(0, Math.round(draft.cookingTime))
          : 0,
      difficulty: normalizeEnumValue(
        draft?.difficulty,
        ["Easy", "Moderate", "Challenging"],
        "Moderate"
      ),
      servings:
        typeof draft?.servings === "number" && Number.isFinite(draft.servings)
          ? Math.max(0, Math.round(draft.servings))
          : 0,
      cost: normalizeEnumValue(draft?.cost, ["Cheap", "Medium", "Expensive"], "Medium"),
      ingredients,
      steps,
      tags,
      createdAt: new Date().toISOString(),
      image: typeof reel?.displayUrl === "string" && reel.displayUrl.trim() ? reel.displayUrl.trim() : undefined,
      imageUrl:
        typeof reel?.displayUrl === "string" && reel.displayUrl.trim() ? reel.displayUrl.trim() : undefined,
      notes:
        typeof draft?.notes === "string" && draft.notes.trim() ? draft.notes.trim() : "",
      sourceUrl: reel?.inputUrl || reel?.url || "",
      sourcePlatform: "instagram",
      sourceType: "instagram_reel",
      confidence:
        typeof draft?.confidence === "number" && Number.isFinite(draft.confidence)
          ? Math.max(0, Math.min(1, draft.confidence))
          : status === "complete"
          ? 0.75
          : 0.5,
    },
  };
}

function isHighQualityInstagramDraft(normalized) {
  if (!normalized?.recipe) return false;

  const confidence =
    typeof normalized.recipe.confidence === "number" &&
    Number.isFinite(normalized.recipe.confidence)
      ? normalized.recipe.confidence
      : 0;

  const ingredientCount = Array.isArray(normalized.recipe.ingredients)
    ? normalized.recipe.ingredients.filter(
        (item) => typeof item === "string" && item.trim()
      ).length
    : 0;
  const stepCount = Array.isArray(normalized.recipe.steps)
    ? normalized.recipe.steps.filter(
        (item) => typeof item === "string" && item.trim()
      ).length
    : 0;
  const hasTitle =
    typeof normalized.recipe.title === "string" &&
    normalized.recipe.title.trim().length >= 4;

  if (!hasTitle || ingredientCount < 3 || stepCount < 2) {
    return false;
  }

  if (normalized.status === "complete") {
    return true;
  }

  if (confidence >= INSTAGRAM_IMPORT_MIN_CONFIDENCE) {
    return true;
  }

  return ingredientCount >= 8 && stepCount >= 4;
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

  const normalizeNullableNutritionValue = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };

  const validateNutritionInfo = (input) => {
    if (!input || typeof input !== "object") return null;
    const rawPerServing =
      input?.perServing && typeof input.perServing === "object"
        ? input.perServing
        : input;

    const perServing = {
      calories: normalizeNullableNutritionValue(rawPerServing?.calories),
      protein: normalizeNullableNutritionValue(rawPerServing?.protein),
      carbs: normalizeNullableNutritionValue(rawPerServing?.carbs),
      fat: normalizeNullableNutritionValue(rawPerServing?.fat),
    };

    const hasAnyValue = Object.values(perServing).some((value) => value !== null);
    if (!hasAnyValue) return null;

    return {
      perServing,
      source: "ai_generated",
      updatedAt: new Date().toISOString(),
    };
  };

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
    nutritionInfo: validateNutritionInfo(raw.nutritionInfo || raw.nutrition),
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
  let { note, people, time, dietary, avoid, mealType, avoidOther, language, excludeSuggestions } = req.body;
  const timing = createAiTimingLogger("getRecipeSuggestions", {
    language,
    people,
  });

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
  timing.mark("normalized-input");
  const normalizedExcludedSuggestions = Array.isArray(excludeSuggestions)
    ? excludeSuggestions
        .map((entry) => ({
          title: sanitizeInput(entry?.title),
          description: sanitizeInput(entry?.description),
        }))
        .filter((entry) => entry.title || entry.description)
    : [];
  // Normalize measurement system from body (supports several possible field names)
  const measurementSystemNormalized = normalizeMeasurementSystem(
    (req.body && (req.body.measurementSystem || req.body.units || req.body.unitSystem)) || "Metric"
  );

  const mealPart =
    mealType && mealType !== "Im just hungry" && mealType !== "I’m just hungry"
      ? `- Meal type: ${mealType}\n`
      : "";

  const excludedSuggestionsBlock =
    normalizedExcludedSuggestions.length > 0
      ? `\nDo NOT repeat or closely resemble any of these suggestions the user has already seen:\n${normalizedExcludedSuggestions
          .map((entry, index) => `- ${index + 1}. ${entry.title}${entry.description ? `: ${entry.description}` : ""}`)
          .join("\n")}\n`
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
${excludedSuggestionsBlock}

Return ONLY valid JSON of exactly 3 objects, written in ${language}, each matching this schema:
[
  {
    "id": "string",
    "title": "string",
    "cookingTime": number,        // minutes (5–180)
    "difficulty": "Easy" | "Moderate" | "Challenging",
    "calories": number,           // per serving, realistic estimate
    "description": "string"
  },
  ...
]

IMPORTANT: All text in every field must be written entirely in the target language (${language}). If any part of the output is not in ${language}, you must internally re-translate it before returning. Never return text in any other language.
Each of the 3 suggestions must be clearly different from the others in concept, main ingredients, and style.
`;

  const suggestionSchema = {
    type: "object",
    additionalProperties: false,
    required: ["suggestions"],
    properties: {
      suggestions: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "cookingTime", "difficulty", "calories", "description"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            cookingTime: { type: "number" },
            difficulty: {
              type: "string",
              enum: ["Easy", "Moderate", "Challenging"],
            },
            calories: { type: "number" },
            description: { type: "string" },
          },
        },
      },
    },
  };

  try {
    let raw = await requestStructuredJsonCompletion({
      schemaName: "recipe_suggestions",
      schema: suggestionSchema,
      temperature: 0.9,
      timeoutMs: 10000,
      messages: [
        {
          role: "system",
          content:
            `You are a professional chef assistant. Always reply ONLY with valid JSON that matches the schema provided and return exactly 3 recipe suggestions. All text must be written in the user’s selected language (${language}). No matter the input, always reply in ${language}. IMPORTANT: Every string field must be in ${language}. If any part of your output is not in ${language}, you must internally re-translate it before returning. Never return text in any other language. If the selected language is Portuguese (Portugal), always use European Portuguese (Portugal) and never Brazilian Portuguese. When you mention any quantities or units in descriptions, respect the user's measurement system: if it is "Metric", use metric units (g, kg, ml, l, etc.); if it is "US", use US/imperial units (cups, tbsp, tsp, oz, lb, etc.) and never mix systems.`,
        },
        { role: "user", content: userPrompt },
      ],
    });
    timing.mark("openai-response");
    raw = cleanJsonResponse(raw);
    if (process.env.NODE_ENV !== "production") {
      console.log("🧹 Cleaned response (suggestions):", raw);
    }
    const parsedPayload = safeJSONParse(raw, {});
    let suggestions = Array.isArray(parsedPayload?.suggestions)
      ? parsedPayload.suggestions
      : [];
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
        calories: 400,
        description: "No description available.",
      });
    }
    // Batch enforce language on titles and descriptions, but NOT difficulty
    const titles = suggestions.map(s => s.title || "");
    const descriptions = suggestions.map(s => s.description || "");
    const [translatedTitles, translatedDescriptions] = await Promise.all([
      ensureLanguage(titles, language),
      ensureLanguage(descriptions, language),
    ]);
    timing.mark("language-enforcement");
    const forbiddenKeys = new Set(
      normalizedExcludedSuggestions
        .map((entry) => String(entry.title || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const batchSeenKeys = new Set();
    suggestions = suggestions
      .map((s, idx) => ({
        ...s,
        title: translatedTitles[idx] || s.title,
        description: translatedDescriptions[idx] || s.description,
        difficulty: normalizeDifficulty(s.difficulty),
        calories:
          typeof s.calories === "number" && Number.isFinite(s.calories) && s.calories > 0
            ? s.calories
            : null,
    }))
      .filter((s) => {
        const key = String(s?.title || "").trim().toLowerCase();
        if (!key) return false;
        if (forbiddenKeys.has(key)) return false;
        if (batchSeenKeys.has(key)) return false;
        batchSeenKeys.add(key);
        return true;
      })
      .map((s, idx) => ({
        ...s,
        id: `ai_suggestion_${Date.now()}_${idx + 1}`,
      }));

    while (suggestions.length < 3) {
      suggestions.push({
        id: `ai_suggestion_${Date.now()}_fallback_${suggestions.length + 1}`,
        title: `Suggestion ${suggestions.length + 1}`,
        cookingTime: 30,
        difficulty: "Easy",
        calories: 400,
        description: "",
      });
    }
    timing.mark("post-process-complete", { suggestionCount: suggestions.length });

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
  const timing = createAiTimingLogger("getRecipe", {
    language,
    people,
    suggestionId: suggestionId || suggestion?.id || null,
  });

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

  // Economy (cookies): charge for full AI recipe generation (MVP)
  const economySpend = await spendCookies({
    req,
    amount: ECONOMY_LIMITS.COST_AI_RECIPE_FULL,
    reason: "ai_recipe",
  });

  if (economySpend && economySpend.ok === false) {
    return res.status(402).json({
      error: "insufficient_cookies",
      remaining: economySpend.remaining,
      message:
        "You do not have enough Eggs to generate more AI recipes.",
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
  timing.mark("normalized-input");
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
  "ingredients": ["list of ingredients with quantities, always using the user's measurement system (${measurementSystemNormalized})"],
  "steps": ["step-by-step preparation instructions"],
  "tags": ["short tags like Vegan, Vegetarian, Gluten-Free, Dinner, Breakfast"],
  "nutritionInfo": {
    "perServing": {
      "calories": number,
      "protein": number,
      "carbs": number,
      "fat": number
    }
  }
}

For the ingredients and any quantities mentioned in the steps, you MUST strictly use the user's measurement system:
- If the measurement system is "Metric", use metric units such as g, kg, ml, l, etc., and avoid cups/ounces.
- If the measurement system is "US", use US/imperial units such as cups, tablespoons, teaspoons, ounces (oz), pounds (lb), etc., and avoid grams/milliliters.
Never mix measurement systems in the same recipe.

IMPORTANT: All text in every field must be written entirely in the target language (${language}). If any part of the output is not in ${language}, you must internally re-translate it before returning. Never return text in any other language.
`;

  const fullRecipeSchema = {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "cookingTime",
      "difficulty",
      "servings",
      "ingredients",
      "steps",
      "tags",
      "nutritionInfo",
    ],
    properties: {
      title: { type: "string" },
      cookingTime: { type: "number" },
      difficulty: {
        type: "string",
        enum: ["Easy", "Moderate", "Challenging"],
      },
      servings: { type: "number" },
      ingredients: {
        type: "array",
        items: { type: "string" },
      },
      steps: {
        type: "array",
        items: { type: "string" },
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      nutritionInfo: {
        type: "object",
        additionalProperties: false,
        required: ["perServing"],
        properties: {
          perServing: {
            type: "object",
            additionalProperties: false,
            required: ["calories", "protein", "carbs", "fat"],
            properties: {
              calories: { type: "number" },
              protein: { type: "number" },
              carbs: { type: "number" },
              fat: { type: "number" },
            },
          },
        },
      },
    },
  };

  try {
    let raw = await requestStructuredJsonCompletion({
      schemaName: "full_recipe",
      schema: fullRecipeSchema,
      temperature: 0.7,
      timeoutMs: 25000,
      messages: [
        {
          role: "system",
          content:
            `You are a professional chef assistant. Always reply ONLY with valid JSON that matches the schema provided. All text must be written in the user’s selected language (${language}), including ingredients, steps, and tags. No matter the input, always reply in ${language}. IMPORTANT: Every string field must be in ${language}. If any part of your output is not in ${language}, you must internally re-translate it before returning. Never return text in any other language. If the selected language is Portuguese (Portugal), always use European Portuguese (Portugal) and never Brazilian Portuguese. You must strictly respect the user's measurement system: for "Metric" use metric units (g, kg, ml, l, etc.), and for "US" use US/imperial units (cups, tbsp, tsp, oz, lb, etc.). Never mix measurement systems within a single recipe.`,
        },
        { role: "user", content: userPrompt },
      ],
    });
    timing.mark("openai-response");
    raw = cleanJsonResponse(raw);
    if (process.env.NODE_ENV !== "production") {
      console.log("🧹 Cleaned response (recipe):", raw);
    }
    // Use safeJSONParse helper, then validate with mealType for tag normalization
    const parsed = safeJSONParse(raw, {});
    timing.mark("json-parse");
    const safe = validateRecipe(parsed, mealType);
    // Normalize difficulty after validation (ensure always English enum)
    safe.difficulty = normalizeDifficulty(safe.difficulty);


    // --- Enforce language only when the combined recipe text looks mismatched ---
    let languageEnforcementApplied = false;
    if (safe) {
      const titleArr = [safe.title || ""];
      const ingredientsArr = Array.isArray(safe.ingredients) ? safe.ingredients : [];
      const stepsArr = Array.isArray(safe.steps) ? safe.steps : [];
      const combinedRecipeText = [
        safe.title || "",
        ...ingredientsArr,
        ...stepsArr,
      ]
        .filter(Boolean)
        .join("\n");

      if (!isLikelyTargetLanguage(combinedRecipeText, language)) {
        languageEnforcementApplied = true;
        const [translatedTitleArr, translatedIngredients, translatedSteps] = await Promise.all([
          enforceLanguageOnObject(titleArr, language),
          enforceLanguageOnObject(ingredientsArr, language),
          enforceLanguageOnObject(stepsArr, language),
        ]);

        safe.title = translatedTitleArr[0] || safe.title;
        safe.ingredients = translatedIngredients;
        safe.steps = translatedSteps;
      }
      // Do NOT translate difficulty (keep as enum-like label)
    }
    timing.mark("language-enforcement", { applied: languageEnforcementApplied });

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
    timing.mark("post-process-complete", {
      ingredientCount: safe.ingredients.length,
      stepCount: safe.steps.length,
      hasNutritionInfo: !!safe.nutritionInfo,
    });

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
        hasNutritionInfo: !!safe.nutritionInfo,
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
    const fromAddress = process.env.SMTP_FROM || "Cook N'Eat AI Support <no-reply@rafaelpiloto.com>";

    const payload = {
      from: fromAddress,
      to: toAddress,
      subject: `[Cook N'Eat AI Support] ${trimmedSubject}`,
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

app.get("/importRecipesFromFile/formats", (req, res) => {
  return res.json({
    ok: true,
    ...getSupportedImportFormats(),
  });
});

app.post("/importRecipesFromFile", (req, res) => {
  importUpload.single("file")(req, res, async (uploadErr) => {
    if (uploadErr) {
      console.error("❌ /importRecipesFromFile upload error:", {
        code: uploadErr?.code ?? null,
        message: uploadErr?.message ?? String(uploadErr),
      });
      const statusCode = uploadErr?.code === "LIMIT_FILE_SIZE" ? 400 : 400;
      const message =
        uploadErr?.code === "LIMIT_FILE_SIZE"
          ? `This file is too large. The maximum supported size is ${Math.round(
              getSupportedImportFormats().maxFileSizeBytes / (1024 * 1024)
            )} MB.`
          : "The selected file could not be uploaded.";
      return res.status(statusCode).json({
        ok: false,
        code: uploadErr?.code === "LIMIT_FILE_SIZE" ? "IMPORT_FILE_TOO_LARGE" : "IMPORT_UPLOAD_FAILED",
        message,
      });
    }

    try {
      console.log("[/importRecipesFromFile] received file", {
        originalname: req.file?.originalname ?? null,
        mimetype: req.file?.mimetype ?? null,
        size: req.file?.size ?? null,
      });
      const result = await parseImportedRecipes(req.file);

      const ctx = getEventContext(req);
      trackEvent("import_recipes_from_file", {
        userId: ctx.userId,
        deviceId: ctx.deviceId,
        metadata: {
          format: result.format,
          count: result.count,
          filename: req.file?.originalname ?? null,
        },
      });

      return res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      const payload = toImportErrorResponse(err);
      console.error("❌ /importRecipesFromFile error:", err?.message || err);
      return res.status(payload.statusCode).json(payload.body);
    }
  });
});

app.post("/extractRecipeDraftFromUrl", async (req, res) => {
  const rawUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const language = normalizeLanguage(req.body?.language);
  const measurementSystem = normalizeMeasurementSystem(req.body?.measurementSystem);

  if (!rawUrl) {
    return res.status(400).json({ ok: false, error: "URL is required" });
  }

  let normalizedUrl;
  try {
    normalizedUrl = normalizeSourceUrl(rawUrl);
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid URL" });
  }

  if (!/^https?:\/\//i.test(normalizedUrl)) {
    return res.status(400).json({ ok: false, error: "Only http:// or https:// URLs are supported" });
  }

  if (!isInstagramReelUrl(normalizedUrl)) {
    return res.status(400).json({
      ok: false,
      error: "This URL is not a supported Instagram Reel link.",
      code: "UNSUPPORTED_SOURCE_URL",
    });
  }

  try {
    const reel = await fetchInstagramReelDataFromApify(normalizedUrl);
    const draft = await buildInstagramRecipeDraft({
      reel,
      measurementSystem,
    });
    const normalized = normalizeInstagramDraftResponse(draft, reel);
    const recipeConfidence =
      typeof normalized?.recipe?.confidence === "number" &&
      Number.isFinite(normalized.recipe.confidence)
        ? normalized.recipe.confidence
        : 0;

    const ctx = getEventContext(req);
    trackEvent("extract_recipe_draft_from_url", {
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      metadata: {
        sourceType: "instagram_reel",
        status: normalized.status,
        language,
        hasRecipe: !!normalized.recipe,
        confidence: recipeConfidence,
        ownerUsername: reel?.ownerUsername || null,
      },
    });

    if (!normalized.recipe) {
      return res.status(422).json({
        ok: false,
        code: "INSTAGRAM_RECIPE_NOT_EXTRACTED",
        message: normalized.failureReason,
        status: normalized.status,
        warnings: normalized.warnings,
        source: {
          platform: "instagram",
          type: "instagram_reel",
          url: normalizedUrl,
          ownerUsername: reel?.ownerUsername || null,
          ownerFullName: reel?.ownerFullName || null,
        },
      });
    }

    if (!isHighQualityInstagramDraft(normalized)) {
      return res.status(422).json({
        ok: false,
        code: "INSTAGRAM_RECIPE_NOT_EXTRACTED",
        message:
          "We could not build a reliable enough recipe draft from this Instagram Reel. Try another Reel or create the recipe manually.",
        status: normalized.status,
        warnings: normalized.warnings,
        source: {
          platform: "instagram",
          type: "instagram_reel",
          url: normalizedUrl,
          ownerUsername: reel?.ownerUsername || null,
          ownerFullName: reel?.ownerFullName || null,
        },
      });
    }

    const economySpend = await spendCookies({
      req,
      amount: ECONOMY_LIMITS.COST_IMPORT_INSTAGRAM_REEL,
      reason: "import_instagram_reel",
    });

    if (!economySpend.ok) {
      return respondNotEnoughCookies(res, {
        action: "import_instagram_reel",
        requiredCookies:
          economySpend.requiredCookies ||
          ECONOMY_LIMITS.COST_IMPORT_INSTAGRAM_REEL,
        balance: economySpend.remaining,
        remainingFreePremiumActions: economySpend.remainingFreePremiumActions,
        message: `You need ${ECONOMY_LIMITS.COST_IMPORT_INSTAGRAM_REEL} Eggs to import a recipe from an Instagram Reel.`,
      });
    }

    return res.json({
      ok: true,
      status: normalized.status,
      recipe: normalized.recipe,
      warnings: normalized.warnings,
      premiumActionSource: economySpend?.source || null,
      chargedCookies:
        typeof economySpend?.charged === "number" ? economySpend.charged : 0,
      remainingCookies:
        typeof economySpend.remaining === "number" ? economySpend.remaining : null,
      remainingFreePremiumActions:
        typeof economySpend?.remainingFreePremiumActions === "number"
          ? economySpend.remainingFreePremiumActions
          : null,
      source: {
        platform: "instagram",
        type: "instagram_reel",
        url: normalizedUrl,
        ownerUsername: reel?.ownerUsername || null,
        ownerFullName: reel?.ownerFullName || null,
      },
    });
  } catch (err) {
    console.error("❌ /extractRecipeDraftFromUrl error:", err?.message || err);
    return res.status(err?.statusCode || 502).json({
      ok: false,
      code: err?.code || "INSTAGRAM_RECIPE_EXTRACTION_FAILED",
      message:
        err?.message ||
        "This Instagram Reel could not be accessed. Make sure the link is public and still available.",
    });
  }
});

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
  recordUrlImportTelemetry({
    url,
    host: _parsedUrl.host,
    status: "attempt",
    stage: "request_received",
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
  function normalizeImportedRecipe(scraped, req, sourceUrl) {
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
    function parseNutritionNumber(value) {
      if (value === null || value === undefined || value === "") return null;
      if (typeof value === "number") {
        return Number.isFinite(value) && value >= 0 ? value : null;
      }
      if (typeof value !== "string") return null;
      const normalized = he
        .decode(value)
        .replace(",", ".")
        .replace(/\s+/g, " ")
        .trim();
      const match = normalized.match(/-?\d+(?:\.\d+)?/);
      if (!match) return null;
      const parsed = Number(match[0]);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
    function validateImportedNutritionInfo(input) {
      if (!input || typeof input !== "object") return null;
      const raw =
        input.perServing && typeof input.perServing === "object"
          ? input.perServing
          : input;
      const perServing = {
        calories: parseNutritionNumber(raw.calories ?? raw.caloriesContent ?? raw.energy ?? raw.kcal),
        protein: parseNutritionNumber(raw.protein ?? raw.proteinContent),
        carbs: parseNutritionNumber(
          raw.carbs ?? raw.carbohydrates ?? raw.carbohydrateContent ?? raw.carbohydratesContent
        ),
        fat: parseNutritionNumber(raw.fat ?? raw.fatContent),
      };
      const hasAnyValue = Object.values(perServing).some((value) => value !== null);
      if (!hasAnyValue) return null;
      return {
        perServing,
        source: "imported_url",
        updatedAt: new Date().toISOString(),
      };
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
        const numericCapture = match.slice(1).find((value) => /^\d{1,4}$/.test(String(value || "").trim()));
        return numericCapture ? parseInt(numericCapture, 10) : null;
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
            image = new URL(imgVal, sourceUrl || req.protocol + "://" + req.get("host") + "/").href;
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
                foundImg = new URL(img.trim(), sourceUrl || req.protocol + "://" + req.get("host") + "/").href;
                break;
              } catch (e) { }
            }
          } else if (img && typeof img === "object" && typeof img.url === "string" && img.url.trim()) {
            if (/^https?:\/\//i.test(img.url.trim())) {
              foundImg = img.url.trim();
              break;
            } else {
              try {
                foundImg = new URL(img.url.trim(), sourceUrl || req.protocol + "://" + req.get("host") + "/").href;
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
            image = new URL(imgVal, sourceUrl || req.protocol + "://" + req.get("host") + "/").href;
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
      servings: typeof servings === "number" && isFinite(servings) ? servings : null,
      cost: "Medium",
      ingredients,
      steps,
      tags,
      nutritionInfo: validateImportedNutritionInfo(scraped.nutritionInfo || scraped.nutrition),
      createdAt: new Date().toISOString(),
      image,
    };
  }

  try {
    // Fetch raw HTML with timeout and size limit (2 MB)
    const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB
    const browserLikeHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,pt-PT;q=0.8,pt;q=0.7",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Upgrade-Insecure-Requests": "1",
    };

    async function fetchRecipePage(fetchUrl, headers = {}) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s
      try {
        return await fetch(fetchUrl, {
          signal: controller.signal,
          size: MAX_HTML_BYTES,
          redirect: "follow",
          compress: true,
          headers,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    }

    function buildFetchCandidates(rawUrl) {
      const candidates = [rawUrl];
      try {
        const parsed = new URL(rawUrl);
        const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
        if (host === "allrecipes.com") {
          const printUrl = new URL(rawUrl);
          printUrl.searchParams.set("print", "1");
          candidates.push(printUrl.toString());

          const outputUrl = new URL(rawUrl);
          outputUrl.searchParams.set("output", "1");
          candidates.push(outputUrl.toString());
        }
      } catch {
        // ignore malformed alt candidate creation
      }
      return Array.from(new Set(candidates));
    }

    function buildAllrecipesSecondaryCandidates(rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
        if (host !== "allrecipes.com") return [];
        const segments = parsed.pathname.split("/").filter(Boolean);
        const slug = segments[segments.length - 1] || "";
        if (!slug) return [];
        const capitalizedSlug = slug
          .split("-")
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join("-");
        return Array.from(
          new Set([
            `https://www.punchfork.com/recipe/${capitalizedSlug}-Allrecipes`,
            `https://www.punchfork.com/recipe/${slug}-Allrecipes`,
          ])
        );
      } catch {
        return [];
      }
    }

    async function scrapeRecipeCandidates(candidateUrls) {
      let lastError = null;
      for (const candidateUrl of candidateUrls) {
        try {
          return await scrapeRecipe(candidateUrl);
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError || new Error("recipe-scraper failed for all candidates");
    }

    async function tryAllrecipesSecondarySource(rawUrl, requestInfo) {
      const secondaryUrls = buildAllrecipesSecondaryCandidates(rawUrl);
      if (!secondaryUrls.length) return null;

      for (const secondaryUrl of secondaryUrls) {
        try {
          const secondaryResponse = await fetchRecipePage(secondaryUrl, browserLikeHeaders);
          if (!secondaryResponse.ok) continue;
          const secondaryHtml = await secondaryResponse.text();
          const extracted = extractRecipeFromHtml({
            url: secondaryUrl,
            html: secondaryHtml,
            requestInfo,
          });
          if (!extracted?.recipe) continue;

          const recipe = {
            ...extracted.recipe,
            sourceUrl: rawUrl,
          };

          const hasRealSteps =
            Array.isArray(recipe.steps) &&
            recipe.steps.some((step) => typeof step === "string" && step.trim() && step !== "No steps provided");

          if (!hasRealSteps) {
            const stepSchema = {
              type: "object",
              additionalProperties: false,
              required: ["steps"],
              properties: {
                steps: {
                  type: "array",
                  minItems: 3,
                  maxItems: 8,
                  items: { type: "string" },
                },
              },
            };

            let raw = await requestStructuredJsonCompletion({
              schemaName: "allrecipes_secondary_steps",
              schema: stepSchema,
              temperature: 0.2,
              timeoutMs: 12000,
              messages: [
                {
                  role: "system",
                  content:
                    "You reconstruct plausible cooking steps from a known recipe title and grounded ingredient list. Keep steps concise, practical, and conservative. Do not invent unusual ingredients or techniques.",
                },
                {
                  role: "user",
                  content: `
Generate 4 to 8 concise cooking steps for this recipe.

Recipe title: ${recipe.title}
Servings: ${recipe.servings}
Cooking time target: ${recipe.cookingTime} minutes
Ingredients:
${recipe.ingredients.map((ingredient) => `- ${ingredient}`).join("\n")}

Rules:
- Use only the grounded ingredient list above.
- Keep the steps practical and generic when exact source details are unknown.
- Do not add story text.
- Return only JSON.
`,
                },
              ],
            });

            raw = cleanJsonResponse(raw);
            const parsedSteps = safeJSONParse(raw, null);
            if (parsedSteps?.steps?.length) {
              recipe.steps = parsedSteps.steps.map((step) => String(step || "").trim()).filter(Boolean);
            }
          }

          return {
            recipe,
            stage: "allrecipes_secondary_source",
            extractor: "punchfork_plus_ai_steps",
          };
        } catch {
          // keep trying secondary candidates
        }
      }

      return null;
    }

    let response;
    let earlyFetchFailure = null;
    try {
      const candidateUrls = buildFetchCandidates(url);
      const headerVariants = [
        browserLikeHeaders,
        {
          ...browserLikeHeaders,
          "Accept-Language": "en-US,en;q=0.9",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
        },
      ];

      for (const candidateUrl of candidateUrls) {
        for (const headers of headerVariants) {
          response = await fetchRecipePage(candidateUrl, headers);
          if (response.ok) {
            break;
          }
        }
        if (response?.ok) {
          break;
        }
      }
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.type === 'aborted')) {
        console.error("❌ ImportRecipeFromUrl 408 - Fetch timeout for:", url);
        earlyFetchFailure = { status: 408, error: "Fetch timed out (15s)" };
      }
      else if (err && (/max\s*size/i.test(String(err.message)) || err.type === 'max-size')) {
        console.error("❌ ImportRecipeFromUrl 413 - Response too large for:", url);
        earlyFetchFailure = { status: 413, error: "Response too large (>2MB)" };
      } else {
        console.error("❌ ImportRecipeFromUrl fetch error:", err);
        earlyFetchFailure = { status: 502, error: "Failed to fetch URL" };
      }
    }

    if (!response.ok) {
      console.error("❌ ImportRecipeFromUrl fetch non-OK:", response.status, url);
      earlyFetchFailure = { status: 502, error: `Upstream responded with ${response.status}` };
    }

    let html = "";
    if (response?.ok) {
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader && Number(contentLengthHeader) > MAX_HTML_BYTES) {
        try { response.body && response.body.cancel && response.body.cancel(); } catch (_) { }
        console.error("❌ ImportRecipeFromUrl 413 - Declared Content-Length too large:", contentLengthHeader);
        earlyFetchFailure = { status: 413, error: "Response too large (>2MB)" };
      }
    }

    if (response?.ok && !earlyFetchFailure) {
      try {
        html = await response.text();
      } catch (e) {
        console.error("❌ ImportRecipeFromUrl reading body failed:", e);
        earlyFetchFailure = { status: 502, error: "Failed to read response body" };
      }
    }

    const requestInfo = {
      protocol: req.protocol,
      host: req.get("host"),
    };

    let extractedByService = null;
    if (html) {
      extractedByService = extractRecipeFromHtml({
        url,
        html,
        requestInfo,
      });

      if (extractedByService?.recipe) {
        recordUrlImportTelemetry({
          url,
          host: _parsedUrl.host,
          status: "success",
          stage: extractedByService.stage,
          extractor: extractedByService.extractor,
          looksRecipeLike: extractedByService.looksRecipeLike,
        });
        trackEvent("import_recipe_from_url_result", {
          userId: ctx.userId,
          deviceId: ctx.deviceId,
          metadata: {
            host: _parsedUrl.host,
            status: "success",
            stage: extractedByService.stage,
            extractor: extractedByService.extractor,
          },
        });
        return res.json({ recipe: extractedByService.recipe });
      }
    }

    // Try JSON-LD
    if (html) {
      const ldRecipes = extractJsonLd(html);
      if (ldRecipes.length > 0) {
        const safe = normalizeImportedRecipe(ldRecipes[0], req, url);
        recordUrlImportTelemetry({
          url,
          host: _parsedUrl.host,
          status: "success",
          stage: "jsonld_legacy",
          extractor: "jsonld_legacy",
          looksRecipeLike: true,
        });
        return res.json({ recipe: safe });
      }
    }

    // Try recipe-scraper
    const recipeScraperCandidates = buildFetchCandidates(url);

    try {
      const scraped = await scrapeRecipeCandidates(recipeScraperCandidates);
      const safe = normalizeImportedRecipe(scraped, req, url);
      recordUrlImportTelemetry({
        url,
        host: _parsedUrl.host,
        status: "success",
        stage: "recipe_scraper",
        extractor: "recipe_scraper",
        looksRecipeLike: true,
      });
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
        const safe = normalizeImportedRecipe(scraped, req, url);
        return res.json({ recipe: safe });
      }
    }

    // Continente specific scraper
    if (url.includes("feed.continente.pt")) {
      const $ = cheerio.load(html);
      const title = he.decode($("h1").first().text().trim());
      const collectContinenteSectionItems = (headingRegex, mode = "ingredients") => {
        const items = [];
        const seen = new Set();
        const headings = $("h1, h2, h3, h4, h5, h6, strong, [role='heading']");
        let heading = null;

        headings.each((_, el) => {
          const text = $(el).text().replace(/\s+/g, " ").trim();
          if (!heading && headingRegex.test(text)) {
            heading = $(el);
          }
        });

        if (!heading || !heading.length) {
          return items;
        }

        const pushItem = (rawText) => {
          const text = String(rawText || "").replace(/\s+/g, " ").trim();
          if (!text) return;
          if (/^adicionar à lista de compras$/i.test(text)) return;
          if (/^gostou desta receita\??$/i.test(text)) return;
          if (/^avalie esta receita$/i.test(text)) return;
          const normalized =
            mode === "ingredients" ? cleanIngredient(text) : he.decode(text).trim();
          if (!normalized || seen.has(normalized)) return;
          seen.add(normalized);
          items.push(normalized);
        };

        let current = heading.next();
        let siblingSteps = 0;
        while (current && current.length && siblingSteps < 80) {
          siblingSteps += 1;
          const nodeName = (current.get(0)?.tagName || "").toLowerCase();
          const text = current.text().replace(/\s+/g, " ").trim();

          if (
            /^(ingredientes|prepara[cç][aã]o|informa[cç][aã]o nutricional|utens[ií]lios [uú]teis|gostou desta receita\??|tamb[eé]m vai gostar|veja tamb[eé]m)$/i.test(
              text
            ) &&
            headingRegex.test(text) === false
          ) {
            break;
          }

          if (/^adicionar à lista de compras$/i.test(text)) {
            break;
          }

          if (nodeName === "ul" || nodeName === "ol") {
            current.find("li").each((_, li) => {
              pushItem($(li).text());
            });
          } else if (nodeName === "li") {
            pushItem(text);
          } else if (mode === "steps" && (nodeName === "p" || nodeName === "div")) {
            if (/^\d+[.)]?$/.test(text)) {
              current = current.next();
              continue;
            }
            pushItem(text);
          }

          current = current.next();
        }

        return items;
      };

      let ingredients = collectContinenteSectionItems(/^ingredientes$/i, "ingredients");
      let steps = collectContinenteSectionItems(/^prepara[cç][aã]o$/i, "steps");

      if (!ingredients.length) {
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
          if ($(el).is("li")) {
            const txt = $(el).text().trim();
            if (txt) {
              const cleaned = cleanIngredient(txt);
              if (cleaned && !ingredients.includes(cleaned)) ingredients.push(cleaned);
            }
          }
        });
      }

      if (!steps.length) {
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
      }

      let servings;
      const servingsText = $("body").text().match(/(\d{1,3})\s+por[cç][õo]es/i);
      if (servingsText) {
        servings = parseInt(servingsText[1], 10);
      }

      let totalTime = null;
      const timeMatch = $("body").text().match(/(?:Prep:\s*)?(\d{1,3})\s*min/i);
      if (timeMatch) {
        totalTime = parseInt(timeMatch[1], 10);
      }

      if (ingredients.length || steps.length) {
        const scraped = {
          name: title,
          ingredients,
          instructions: steps,
        };
        if (servings) scraped.yield = servings.toString();
        if (totalTime) scraped.totalTime = totalTime;
        const safe = normalizeImportedRecipe(scraped, req, url);
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
        const safe = normalizeImportedRecipe(scraped, req, url);
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
        const safe = normalizeImportedRecipe(scraped, req, url);
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
        const safe = normalizeImportedRecipe(scraped, req, url);
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
        const safe = normalizeImportedRecipe(scraped, req, url);
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
        const safe = normalizeImportedRecipe(scraped, req, url);
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
        const safe = normalizeImportedRecipe(scraped, req, url);
        return res.json({ recipe: safe });
      }
    }

    // Simple heuristic fallback (title + ingredients list from HTML)
    if (html) {
      const $ = cheerio.load(html);
      const title = $("h1").first().text();
      const ingredients = $("li:contains(ingred)").map((i, el) => $(el).text()).get();

      if (title && ingredients.length) {
        const safe = normalizeImportedRecipe({ title, ingredients, instructions: [] }, req, url);
        recordUrlImportTelemetry({
          url,
          host: _parsedUrl.host,
          status: "success",
          stage: "simple_heuristic",
          extractor: "simple_heuristic",
          looksRecipeLike: true,
        });
        return res.json({ recipe: safe });
      }
    }

    // ---------- Generic multilanguage fallback ----------
    if (html) {
      try {
        const ldRecipesGeneric = extractJsonLd(html);
        if (ldRecipesGeneric.length > 0) {
          const safe = normalizeImportedRecipe(ldRecipesGeneric[0], req, url);
          recordUrlImportTelemetry({
            url,
            host: _parsedUrl.host,
            status: "success",
            stage: "jsonld_generic_legacy",
            extractor: "jsonld_generic_legacy",
            looksRecipeLike: true,
          });
          return res.json({ recipe: safe });
        }
      } catch (e) {
        console.warn("Generic JSON-LD extract failed");
      }
    }

    try {
      const scrapedGeneric = await scrapeRecipeCandidates(recipeScraperCandidates);
      const safe = normalizeImportedRecipe(scrapedGeneric, req, url);
      recordUrlImportTelemetry({
        url,
        host: _parsedUrl.host,
        status: "success",
        stage: "recipe_scraper_generic_legacy",
        extractor: "recipe_scraper_generic_legacy",
        looksRecipeLike: true,
      });
      return res.json({ recipe: safe });
    } catch (e) {
      console.warn("Generic recipe-scraper failed, trying heuristics.");
    }

    // Heuristic multilanguage extraction
    if (html) {
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
        const safe = normalizeImportedRecipe({ name: genTitle, ingredients: genIngredients, instructions: genSteps }, req, url);
        recordUrlImportTelemetry({
          url,
          host: _parsedUrl.host,
          status: "success",
          stage: "generic_heuristic_legacy",
          extractor: "generic_heuristic_legacy",
          looksRecipeLike: true,
        });
        return res.json({ recipe: safe });
      }
    }

    if (earlyFetchFailure && _parsedUrl.host.replace(/^www\./i, "").toLowerCase() === "allrecipes.com") {
      const secondaryResult = await tryAllrecipesSecondarySource(url, requestInfo);
      if (secondaryResult?.recipe) {
        recordUrlImportTelemetry({
          url,
          host: _parsedUrl.host,
          status: "success",
          stage: secondaryResult.stage,
          extractor: secondaryResult.extractor,
          looksRecipeLike: true,
        });
        trackEvent("import_recipe_from_url_result", {
          userId: ctx.userId,
          deviceId: ctx.deviceId,
          metadata: {
            host: _parsedUrl.host,
            status: "success",
            stage: secondaryResult.stage,
            extractor: secondaryResult.extractor,
          },
        });
        return res.json({ recipe: secondaryResult.recipe });
      }
    }

    // ---------- Final AI fallback ----------
    try {
      const $ai = cheerio.load(html);
      $ai("script, style, noscript, svg").remove();
      const pageTitle = he.decode(
        $ai("h1").first().text().trim() || $ai("title").text().trim() || ""
      );
      const pageText = $ai("body").text().replace(/\s+/g, " ").trim().slice(0, 18000);

      const aiSchema = {
        type: "object",
        additionalProperties: false,
        required: ["title", "cookingTime", "difficulty", "servings", "cost", "ingredients", "steps", "tags", "nutritionInfo"],
        properties: {
          title: { type: "string" },
          cookingTime: { type: "number" },
          difficulty: { type: "string", enum: ["Easy", "Moderate", "Challenging"] },
          servings: { type: "number" },
          cost: { type: "string", enum: ["Cheap", "Medium", "Expensive"] },
          ingredients: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
          },
          steps: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
          nutritionInfo: {
            type: "object",
            additionalProperties: false,
            required: ["perServing"],
            properties: {
              perServing: {
                type: "object",
                additionalProperties: false,
                required: ["calories", "protein", "carbs", "fat"],
                properties: {
                  calories: { type: "number" },
                  protein: { type: "number" },
                  carbs: { type: "number" },
                  fat: { type: "number" },
                },
              },
            },
          },
        },
      };

      let raw = await requestStructuredJsonCompletion({
        schemaName: "import_recipe_from_url_fallback",
        schema: aiSchema,
        temperature: 0.2,
        timeoutMs: 20000,
        messages: [
          {
            role: "system",
            content:
              "You extract recipes from webpage text. If the content is not a recipe page, return an empty recipe structure with title as an empty string and empty arrays for ingredients and steps.",
          },
          {
            role: "user",
            content: `
Extract a recipe from this webpage content.

Rules:
- Only return a recipe if the page clearly contains a recipe with ingredients and preparation steps.
- Preserve the original language used in the recipe.
- Ingredients must include quantities when they are present in the page.
- Steps must be concise cooking instructions, not editorial text.
- Keep the response compact: no more than 10 steps, merging tiny adjacent actions when helpful.
- cookingTime should be in minutes.
- difficulty should be one of Easy, Moderate, or Challenging.
- servings should be a realistic integer.
- cost should be Cheap, Medium, or Expensive.
- tags should be short food-related tags.
- nutritionInfo should be per serving, copied from the page when present; otherwise estimate conservatively from the recipe.
- If this is not clearly a recipe page, return:
  {
    "title": "",
    "cookingTime": 30,
    "difficulty": "Moderate",
    "servings": 4,
    "cost": "Medium",
    "ingredients": [],
    "steps": [],
    "tags": [],
    "nutritionInfo": {
      "perServing": {
        "calories": 0,
        "protein": 0,
        "carbs": 0,
        "fat": 0
      }
    }
  }

URL: ${url}
Page title: ${pageTitle}
Visible page text:
"""
${pageText}
"""
`,
          },
        ],
      });

      raw = cleanJsonResponse(raw);
      const fallbackTitle = pageTitle || inferRecipeTitleFromUrl(url);
      const parsed =
        safeJSONParse(raw, null) ||
        recoverRecipeFromJsonLike(raw, fallbackTitle);

      if (parsed && (!parsed.title || !String(parsed.title).trim())) {
        parsed.title = fallbackTitle || "Untitled Recipe";
      }
      const hasMeaningfulRecipe =
        parsed &&
        typeof parsed.title === "string" &&
        parsed.title.trim().length > 0 &&
        Array.isArray(parsed.ingredients) &&
        parsed.ingredients.filter((item) => typeof item === "string" && item.trim()).length > 0 &&
        Array.isArray(parsed.steps) &&
        parsed.steps.filter((item) => typeof item === "string" && item.trim()).length > 0;

      if (hasMeaningfulRecipe) {
        const safe = validateRecipe(parsed, null);
        recordUrlImportTelemetry({
          url,
          host: _parsedUrl.host,
          status: "success",
          stage: "ai_fallback",
          extractor: "ai_fallback",
          looksRecipeLike: extractedByService?.looksRecipeLike ?? null,
        });
        trackEvent("import_recipe_from_url_result", {
          userId: ctx.userId,
          deviceId: ctx.deviceId,
          metadata: {
            host: _parsedUrl.host,
            status: "success",
            stage: "ai_fallback",
            extractor: "ai_fallback",
          },
        });
        return res.json({ recipe: safe });
      }
    } catch (e) {
      console.warn("AI URL import fallback failed:", e?.message || e);
    }

    console.error("❌ ImportRecipeFromUrl 422 - Could not detect recipe structure");
      recordUrlImportTelemetry({
        url,
        host: _parsedUrl.host,
        status: "failure",
        stage: "no_recipe_detected",
        extractor: null,
        reason: earlyFetchFailure?.error || "could_not_detect_recipe_structure",
        looksRecipeLike: extractedByService?.looksRecipeLike ?? null,
      });
    trackEvent("import_recipe_from_url_result", {
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      metadata: {
        host: _parsedUrl.host,
        status: "failure",
        stage: "no_recipe_detected",
        fetchFailure: earlyFetchFailure?.error || null,
        looksRecipeLike: extractedByService?.looksRecipeLike ?? null,
      },
    });
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
