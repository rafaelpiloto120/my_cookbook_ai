import * as cheerio from "cheerio";
import yauzl from "yauzl";
import zlib from "zlib";

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 60 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1000;
const MAX_ARCHIVE_RATIO = 150;
const MAX_IMPORT_RECIPES = 200;
const MAX_INGREDIENTS_PER_RECIPE = 200;
const MAX_STEPS_PER_RECIPE = 100;
const MAX_TAGS_PER_RECIPE = 50;
const MAX_TITLE_LENGTH = 200;
const MAX_INGREDIENT_LENGTH = 500;
const MAX_STEP_LENGTH = 4000;
const MAX_TEXT_FIELD_LENGTH = 12000;
const MAX_EMBEDDED_IMAGE_BYTES = 2 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 30000;

const ALLOWED_EXTENSIONS = new Set([
  ".rtk",
  ".paprikarecipes",
  ".zip",
  ".html",
  ".htm",
  ".csv",
]);

const EXTENSION_TO_FORMAT = {
  ".rtk": "rtk",
  ".paprikarecipes": "paprikarecipes",
  ".zip": "zip",
  ".html": "html",
  ".htm": "html",
  ".csv": "csv",
};

const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const JSON_EXTENSIONS = new Set([".json", ".recipe"]);
const TEXT_EXTENSIONS = new Set([".txt", ".text"]);

const SUPPORTED_FORMATS = [
  { id: "rtk", extension: ".rtk", label: "My Recipe Box (.rtk)" },
  { id: "paprikarecipes", extension: ".paprikarecipes", label: "Paprika (.paprikarecipes)" },
  { id: "zip", extension: ".zip", label: "Recipe Backup (.zip)" },
  { id: "html", extension: ".html", label: "HTML Export (.html, .htm)" },
  { id: "csv", extension: ".csv", label: "CSV (.csv)" },
];

export function getSupportedImportFormats() {
  return {
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    maxRecipes: MAX_IMPORT_RECIPES,
    formats: SUPPORTED_FORMATS,
  };
}

class ImportError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function withTimeout(promise, ms, message = "Import timed out") {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new ImportError("IMPORT_TIMEOUT", message, 408)), ms);
    }),
  ]);
}

function getExtension(filename = "") {
  const idx = filename.lastIndexOf(".");
  if (idx < 0) return "";
  return filename.slice(idx).toLowerCase();
}

function sanitizeText(input, maxLen = MAX_TEXT_FIELD_LENGTH) {
  if (input == null) return "";
  const text = String(input)
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > maxLen ? text.slice(0, maxLen).trim() : text;
}

function sanitizeLine(input, maxLen) {
  return sanitizeText(input, maxLen).replace(/\n+/g, " ").trim();
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function looksLikeGzip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function bufferToUtf8(buffer) {
  if (!Buffer.isBuffer(buffer)) return "";
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function getMimeTypeFromExtension(ext = "") {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function getBasename(input = "") {
  const normalized = String(input || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function ensureSupportedUpload(file) {
  if (!file) {
    throw new ImportError("IMPORT_FILE_REQUIRED", "Please select one file to import.");
  }

  const ext = getExtension(file.originalname || file.name || "");
  console.log("[ImportFromFile] validate upload", {
    originalname: file.originalname || null,
    name: file.name || null,
    mimetype: file.mimetype || file.type || null,
    size: typeof file.size === "number" ? file.size : null,
    detectedExtension: ext,
  });
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new ImportError(
      "IMPORT_UNSUPPORTED_FILE_TYPE",
      "Unsupported file type. Supported formats are .rtk, .paprikarecipes, .zip, .html, and .csv."
    );
  }

  const size = typeof file.size === "number" ? file.size : Buffer.byteLength(file.buffer || Buffer.alloc(0));
  if (size <= 0) {
    throw new ImportError("IMPORT_EMPTY_FILE", "The selected file is empty.");
  }
  if (size > MAX_FILE_SIZE_BYTES) {
    throw new ImportError(
      "IMPORT_FILE_TOO_LARGE",
      `This file is too large. The maximum supported size is ${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB.`
    );
  }

  if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new ImportError("IMPORT_FILE_READ_FAILED", "The selected file could not be read.");
  }

  return ext;
}

function splitTextLines(text, maxLen) {
  return sanitizeText(text, maxLen)
    .split(/\n+/)
    .map((line) => sanitizeLine(line, maxLen))
    .filter(Boolean);
}

function cleanIngredientLine(input) {
  let line = sanitizeLine(input, MAX_INGREDIENT_LENGTH);
  if (!line) return "";

  // Some Recipe Box exports encode missing quantity as Infinity in the rendered ingredient string.
  line = line.replace(/^(?:Infinity|∞)\s+/i, "");

  return line;
}

function parseIngredientArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return cleanIngredientLine(item);
        if (item && typeof item === "object") {
          const explicitText = firstDefined(
            item.text,
            item.original,
            item.description,
            item.display,
            item.name
          );

          const quantityValue = firstDefined(
            item.quantity,
            item.qty,
            item.amount,
            item.value,
            item.number
          );
          const unitValue = firstDefined(item.unit, item.measure, item.unitName, item.symbol);
          const nameValue = firstDefined(item.name, item.ingredient, item.label, item.food, item.title);

          if (explicitText) {
            return cleanIngredientLine(explicitText);
          }

          const quantity =
            typeof quantityValue === "number" && Number.isFinite(quantityValue)
              ? String(quantityValue)
              : typeof quantityValue === "string" && quantityValue.trim() && !/^(?:Infinity|∞)$/i.test(quantityValue.trim())
              ? quantityValue.trim()
              : "";
          const unit = typeof unitValue === "string" ? unitValue.trim() : "";
          const name = typeof nameValue === "string" ? nameValue.trim() : "";

          return cleanIngredientLine([quantity, unit, name].filter(Boolean).join(" "));
        }
        return "";
      })
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return splitTextLines(value, MAX_INGREDIENT_LENGTH).map(cleanIngredientLine).filter(Boolean);
  }
  return [];
}

function parseSteps(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return sanitizeText(item, MAX_STEP_LENGTH);
        if (item && typeof item === "object") {
          return sanitizeText(
            item.text ?? item.description ?? item.instruction ?? item.step ?? "",
            MAX_STEP_LENGTH
          );
        }
        return "";
      })
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const normalized = sanitizeText(value, MAX_STEP_LENGTH * MAX_STEPS_PER_RECIPE);
    return normalized
      .split(/\n+|(?<=\.)\s+(?=[A-Z0-9])/)
      .map((step) => sanitizeText(step, MAX_STEP_LENGTH))
      .filter(Boolean);
  }
  return [];
}

function parseTags(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[,\n;]/);
  return raw
    .map((tag) => sanitizeLine(typeof tag === "string" ? tag : tag?.name ?? tag?.title ?? "", 80))
    .filter(Boolean)
    .slice(0, MAX_TAGS_PER_RECIPE);
}

function parseServings(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.round(value));
  if (typeof value === "string") {
    const match = value.match(/(\d+(?:\.\d+)?)/);
    if (match) return Math.max(1, Math.round(Number(match[1])));
  }
  if (value && typeof value === "object") {
    const direct = firstDefined(
      value.servings,
      value.yield,
      value.quantity,
      value.qty,
      value.amount,
      value.value,
      value.portions,
      value.count
    );
    const parsed = parseServings(direct);
    if (parsed > 0) return parsed;

    if (Array.isArray(value.items) && value.items.length > 0) {
      const nested = parseServings(value.items[0]);
      if (nested > 0) return nested;
    }
  }
  return 0;
}

function parseSingleTimeValue(value) {
  if (value && typeof value === "object") {
    const nested = firstDefined(
      value.total,
      value.totalTime,
      value.total_time,
      value.cooking,
      value.cookTime,
      value.cook_time,
      value.preparation,
      value.prepTime,
      value.prep_time,
      value.inactive,
      value.inactiveTime,
      value.inactive_time,
      value.value,
      value.minutes,
      value.duration
    );
    return parseSingleTimeValue(nested);
  }

  for (const current of [value]) {
    const value = current;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.round(value);
    }
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;

    const iso = trimmed.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
    if (iso) {
      const hours = iso[1] ? Number(iso[1]) : 0;
      const minutes = iso[2] ? Number(iso[2]) : 0;
      return hours * 60 + minutes;
    }

    let total = 0;
    const hours = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/gi)];
    const minutes = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/gi)];
    if (hours.length || minutes.length) {
      hours.forEach((m) => {
        total += Number(m[1]) * 60;
      });
      minutes.forEach((m) => {
        total += Number(m[1]);
      });
      if (total > 0) return Math.round(total);
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.round(numeric);
    }
  }

  return null;
}

function parseCookingTimeMinutes(...values) {
  for (const value of values) {
    const parsed = parseSingleTimeValue(value);
    if (typeof parsed === "number" && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

function mapDifficulty(value) {
  const normalized = sanitizeLine(value || "", 40).toLowerCase();
  if (normalized.includes("challeng") || normalized.includes("hard")) return "Challenging";
  if (normalized.includes("moderate") || normalized.includes("medium")) return "Moderate";
  return "Moderate";
}

function mapCost(value) {
  const normalized = sanitizeLine(value || "", 40).toLowerCase();
  if (normalized.includes("expensive") || normalized.includes("high")) return "Expensive";
  if (normalized.includes("cheap") || normalized.includes("low")) return "Cheap";
  return "Medium";
}

function makeRecipeId(seed) {
  return `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${seed
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .slice(0, 24)}`;
}

function resolveImportedImage(candidate, archiveFilesByName) {
  const paprikaEmbeddedPhoto =
    typeof candidate?.photo_data === "string" && candidate.photo_data.trim()
      ? candidate.photo_data.trim()
      : Array.isArray(candidate?.photos)
      ? candidate.photos.find(
          (photo) => photo && typeof photo.data === "string" && photo.data.trim().length > 0
        )?.data?.trim() || ""
      : "";

  if (paprikaEmbeddedPhoto) {
    return `data:image/jpeg;base64,${paprikaEmbeddedPhoto.replace(/\s+/g, "")}`;
  }

  const pictureCandidates = Array.isArray(candidate?.pictures)
    ? candidate.pictures
    : candidate?.picture
    ? [candidate.picture]
    : [];

  for (const picture of pictureCandidates) {
    const basename = getBasename(picture);
    const archived = archiveFilesByName?.get(basename);
    if (!archived || !Buffer.isBuffer(archived.buffer)) continue;
    if (archived.buffer.length <= 0 || archived.buffer.length > MAX_EMBEDDED_IMAGE_BYTES) continue;

    const mimeType = getMimeTypeFromExtension(archived.ext || getExtension(basename));
    return `data:${mimeType};base64,${archived.buffer.toString("base64")}`;
  }

  const fallback = firstDefined(
    candidate.imageUrl,
    candidate.image,
    candidate.originalPicture,
    candidate.photo_url,
    candidate.photo,
    candidate.thumbnail
  );

  return sanitizeLine(fallback ?? "", 2048);
}

function isLikelyRecipeIndex(candidate, ingredients, steps, servings, cookingTime) {
  if (steps.length > 0 || ingredients.length === 0) return false;
  if ((servings || 0) > 0 || (cookingTime || 0) > 0) return false;

  const rawIngredients = sanitizeText(candidate.ingredients ?? "", MAX_TEXT_FIELD_LENGTH);
  const lines = rawIngredients
    .split(/\n+/)
    .map((line) => sanitizeLine(line, MAX_INGREDIENT_LENGTH))
    .filter(Boolean);
  const bulletLines = lines.filter((line) => /^[-*]/.test(line)).length;
  const title = sanitizeLine(candidate.title ?? candidate.name ?? "", MAX_TITLE_LENGTH).toLowerCase();

  return bulletLines >= 12 || /\blista\b|\bmenu\b|\bíndice\b|\bindex\b/.test(title);
}

function normalizeRecipeCandidate(candidate, sourceLabel = "import", options = {}) {
  const { archiveFilesByName = null } = options;
  const title = sanitizeLine(
    candidate.title ??
      candidate.name ??
      candidate.recipeName ??
      candidate.label ??
      candidate.headline ??
      "",
    MAX_TITLE_LENGTH
  );

  const ingredients = parseIngredientArray(
    candidate.ingredients ??
      candidate.ingredientLines ??
      candidate.recipeIngredient ??
      candidate.ingredient ??
      candidate.raw_ingredients
  ).slice(0, MAX_INGREDIENTS_PER_RECIPE);

  let steps = parseSteps(
    candidate.steps ??
      candidate.instructions ??
      candidate.directions ??
      candidate.recipeInstructions ??
      candidate.method ??
      candidate.notes ??
      candidate.description
  ).slice(0, MAX_STEPS_PER_RECIPE);

  const tags = parseTags(
    candidate.tags ??
      candidate.categories ??
      candidate.category ??
      candidate.collections ??
      candidate.keywords
  );

  const servings = parseServings(
    candidate.servings ??
      candidate.yield ??
      candidate.recipeYield ??
      candidate.quantity ??
      candidate.portions
  );
  const cookingTime = parseCookingTimeMinutes(
    // Preferred order: total -> cooking -> preparation -> inactive
    candidate.totalTime,
    candidate.total_time,
    candidate.total,
    candidate.times?.total,
    candidate.time?.total,
    candidate.cookingTime,
    candidate.cookTime,
    candidate.cook_time,
    candidate.cooking,
    candidate.times?.cooking,
    candidate.time?.cooking,
    candidate.prepTime,
    candidate.prep_time,
    candidate.preparation,
    candidate.times?.preparation,
    candidate.time?.preparation,
    candidate.inactiveTime,
    candidate.inactive_time,
    candidate.inactive,
    candidate.times?.inactive,
    candidate.time?.inactive
  );

  if (!ingredients.length && !steps.length) {
    return null;
  }

  if (isLikelyRecipeIndex(candidate, ingredients, steps, servings, cookingTime)) {
    return null;
  }

  if (!steps.length && ingredients.length > 0) {
    steps = ["Review this imported recipe and add the cooking steps."];
  }

  const resolvedImage = resolveImportedImage(candidate, archiveFilesByName);

  const normalized = {
    id: makeRecipeId(title || sourceLabel),
    title,
    cookingTime,
    difficulty: mapDifficulty(candidate.difficulty),
    servings,
    cost: mapCost(candidate.cost),
    ingredients,
    steps,
    tags,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    image: resolvedImage,
    imageUrl: resolvedImage,
    cookbooks: [],
    isDeleted: false,
  };

  if (!normalized.image) {
    delete normalized.image;
    delete normalized.imageUrl;
  }

  return normalized;
}

function validateNormalizedRecipe(recipe, index) {
  if (!recipe.title) {
    throw new ImportError(
      "IMPORT_INVALID_RECIPE",
      `Recipe ${index + 1} is missing a title.`
    );
  }
  if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
    throw new ImportError(
      "IMPORT_INVALID_RECIPE",
      `Recipe "${recipe.title}" is missing ingredients.`
    );
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    throw new ImportError(
      "IMPORT_INVALID_RECIPE",
      `Recipe "${recipe.title}" is missing cooking steps.`
    );
  }
}

function validateRecipeBatch(recipes) {
  if (!Array.isArray(recipes) || recipes.length === 0) {
    throw new ImportError("IMPORT_NO_RECIPES_FOUND", "No recipes were found in this file.");
  }
  if (recipes.length > MAX_IMPORT_RECIPES) {
    throw new ImportError(
      "IMPORT_TOO_MANY_RECIPES",
      `This file contains ${recipes.length} recipes. The current limit is ${MAX_IMPORT_RECIPES}.`
    );
  }

  recipes.forEach((recipe, index) => validateNormalizedRecipe(recipe, index));
}

function extractJsonLdRecipes($) {
  const recipes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed)
        ? parsed
        : parsed["@graph"] && Array.isArray(parsed["@graph"])
        ? parsed["@graph"]
        : [parsed];
      nodes.forEach((node) => {
        if (!node || typeof node !== "object") return;
        const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : node["@type"];
        if (typeof type === "string" && type.toLowerCase().includes("recipe")) {
          recipes.push(node);
        }
      });
    } catch {
      // Ignore broken json-ld blocks
    }
  });
  return recipes;
}

function fallbackHtmlRecipe($) {
  const title =
    $("meta[property='og:title']").attr("content") ||
    $("title").first().text() ||
    $("h1").first().text();
  const ingredients = $("li").toArray().map((el) => $(el).text());
  const steps = $("ol li, .instruction, .instructions li, .direction, .directions li")
    .toArray()
    .map((el) => $(el).text());

  if (!title || ingredients.length === 0 || steps.length === 0) {
    return [];
  }

  return [
    {
      title,
      ingredients,
      steps,
      image: $("meta[property='og:image']").attr("content") || "",
    },
  ];
}

function parseHtmlRecipesFromString(html, sourceLabel) {
  const $ = cheerio.load(html);
  const jsonLdRecipes = extractJsonLdRecipes($);
  const fallback = jsonLdRecipes.length > 0 ? [] : fallbackHtmlRecipe($);
  return [...jsonLdRecipes, ...fallback]
    .map((item) => normalizeRecipeCandidate(item, sourceLabel))
    .filter(Boolean);
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  out.push(current);
  return out;
}

function parseCsvRows(text) {
  const rows = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      if (current.trim()) rows.push(parseCsvLine(current));
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) rows.push(parseCsvLine(current));
  return rows;
}

function normalizeCsvHeader(header) {
  return sanitizeLine(header, 100).toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function parseCsvRecipes(text, sourceLabel) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) {
    throw new ImportError(
      "IMPORT_INVALID_CSV",
      "The CSV file must include a header row and at least one recipe row."
    );
  }

  const headers = rows[0].map(normalizeCsvHeader);
  const headerIndex = Object.fromEntries(headers.map((header, index) => [header, index]));

  const titleIdx =
    headerIndex.title ??
    headerIndex.recipe_title ??
    headerIndex.name ??
    headerIndex.recipe_name;

  const ingredientsIdx =
    headerIndex.ingredients ??
    headerIndex.ingredient_lines ??
    headerIndex.ingredient_list;

  const stepsIdx =
    headerIndex.steps ??
    headerIndex.instructions ??
    headerIndex.directions ??
    headerIndex.method;

  if (titleIdx == null) {
    throw new ImportError("IMPORT_INVALID_CSV", 'The CSV file is missing the required "title" column.');
  }
  if (ingredientsIdx == null || stepsIdx == null) {
    throw new ImportError(
      "IMPORT_INVALID_CSV",
      'The CSV file must include "ingredients" and "steps" columns.'
    );
  }

  return rows
    .slice(1)
    .map((row) =>
      normalizeRecipeCandidate(
        {
          title: row[titleIdx],
          ingredients: row[ingredientsIdx],
          steps: row[stepsIdx],
          servings: row[headerIndex.servings ?? headerIndex.yield ?? -1],
          cookingTime: row[headerIndex.cookingtime ?? headerIndex.cooking_time ?? headerIndex.total_time ?? -1],
          difficulty: row[headerIndex.difficulty ?? -1],
          cost: row[headerIndex.cost ?? -1],
          tags: row[headerIndex.tags ?? headerIndex.categories ?? -1],
          image: row[headerIndex.image ?? headerIndex.image_url ?? -1],
        },
        sourceLabel
      )
    )
    .filter(Boolean);
}

function isRecipeLikeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hasTitle = typeof (value.title ?? value.name ?? value.recipeName) === "string";
  const hasIngredients =
    Array.isArray(value.ingredients) ||
    typeof value.ingredients === "string" ||
    Array.isArray(value.recipeIngredient) ||
    Array.isArray(value.ingredientLines);
  const hasSteps =
    Array.isArray(value.steps) ||
    typeof value.steps === "string" ||
    Array.isArray(value.instructions) ||
    typeof value.instructions === "string" ||
    typeof value.directions === "string" ||
    Array.isArray(value.recipeInstructions);

  return hasTitle && (hasIngredients || hasSteps);
}

function collectRecipeLikeObjects(value, found = [], depth = 0) {
  if (depth > 6 || value == null) return found;

  if (Array.isArray(value)) {
    value.forEach((item) => collectRecipeLikeObjects(item, found, depth + 1));
    return found;
  }

  if (isRecipeLikeObject(value)) {
    found.push(value);
  }

  if (typeof value === "object") {
    Object.values(value).forEach((item) => collectRecipeLikeObjects(item, found, depth + 1));
  }

  return found;
}

function parseJsonRecipes(text, sourceLabel, options = {}) {
  const parsed = JSON.parse(text);
  const found = collectRecipeLikeObjects(parsed);
  return found
    .map((item) => normalizeRecipeCandidate(item, sourceLabel, options))
    .filter(Boolean);
}

function openZipFromBuffer(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (err, zipfile) => {
        if (err) return reject(err);
        resolve(zipfile);
      }
    );
  });
}

function readZipEntry(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function readArchiveEntries(buffer) {
  const zipfile = await openZipFromBuffer(buffer);

  return new Promise((resolve, reject) => {
    const files = [];
    let totalUncompressed = 0;
    let entryCount = 0;
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {}
      reject(err);
    }

    function finish() {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {}
      resolve(files);
    }

    zipfile.on("entry", async (entry) => {
      try {
        entryCount += 1;
        if (entryCount > MAX_ARCHIVE_ENTRIES) {
          throw new ImportError(
            "IMPORT_ARCHIVE_TOO_COMPLEX",
            "This archive contains too many files to import safely."
          );
        }

        const ratio =
          entry.compressedSize > 0 ? entry.uncompressedSize / entry.compressedSize : entry.uncompressedSize;
        if (ratio > MAX_ARCHIVE_RATIO) {
          throw new ImportError(
            "IMPORT_ARCHIVE_UNSAFE",
            "This archive appears to be unsafe or heavily compressed."
          );
        }

        totalUncompressed += entry.uncompressedSize;
        if (totalUncompressed > MAX_EXTRACTED_BYTES) {
          throw new ImportError(
            "IMPORT_ARCHIVE_TOO_LARGE",
            "The extracted contents of this archive are too large to import safely."
          );
        }

        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        const raw = await readZipEntry(zipfile, entry);
        const data = looksLikeGzip(raw) ? zlib.gunzipSync(raw) : raw;
        files.push({
          path: entry.fileName,
          ext: getExtension(entry.fileName),
          buffer: data,
        });
        zipfile.readEntry();
      } catch (err) {
        fail(err);
      }
    });

    zipfile.on("error", fail);
    zipfile.on("end", finish);
    zipfile.readEntry();
  });
}

function parseRecipesFromArchiveFiles(files, sourceLabel) {
  const normalized = [];
  let sawPotentialRecipeFormat = false;
  const archiveFilesByName = new Map(
    files.map((file) => [getBasename(file.path), file])
  );

  for (const file of files) {
    const ext = file.ext;
    const text = bufferToUtf8(file.buffer);

    if (ext === ".paprikarecipe") {
      sawPotentialRecipeFormat = true;
      try {
        normalized.push(
          ...parseJsonRecipes(text, `${sourceLabel}:${file.path}`, { archiveFilesByName })
        );
      } catch {
        // ignore individual malformed paprika recipe files
      }
      continue;
    }

    if (JSON_EXTENSIONS.has(ext)) {
      sawPotentialRecipeFormat = true;
      try {
        normalized.push(
          ...parseJsonRecipes(text, `${sourceLabel}:${file.path}`, { archiveFilesByName })
        );
      } catch {
        // ignore individual malformed json blobs
      }
      continue;
    }

    if (HTML_EXTENSIONS.has(ext)) {
      sawPotentialRecipeFormat = true;
      normalized.push(...parseHtmlRecipesFromString(text, `${sourceLabel}:${file.path}`));
      continue;
    }

    if (ext === ".csv") {
      sawPotentialRecipeFormat = true;
      normalized.push(...parseCsvRecipes(text, `${sourceLabel}:${file.path}`));
      continue;
    }

    if (TEXT_EXTENSIONS.has(ext) && /ingredient|direction|instruction|recipe/i.test(text)) {
      sawPotentialRecipeFormat = true;
      normalized.push(
        ...parseHtmlRecipesFromString(`<html><body><pre>${text}</pre></body></html>`, `${sourceLabel}:${file.path}`)
      );
    }
  }

  return { recipes: normalized, sawPotentialRecipeFormat };
}

async function parseArchiveFormat(buffer, sourceLabel) {
  const files = await readArchiveEntries(buffer);
  const { recipes, sawPotentialRecipeFormat } = parseRecipesFromArchiveFiles(files, sourceLabel);

  if (!sawPotentialRecipeFormat) {
    throw new ImportError(
      "IMPORT_UNSUPPORTED_ARCHIVE_FORMAT",
      "This archive is valid, but it is not a supported recipe export format."
    );
  }

  return recipes;
}

async function parseImportedRecipesInner(file) {
  const ext = ensureSupportedUpload(file);
  const format = EXTENSION_TO_FORMAT[ext];
  const sourceLabel = file.originalname || file.name || "import";

  console.log("[ImportFromFile] parse start", {
    sourceLabel,
    extension: ext,
    format,
    size: file?.size ?? file?.buffer?.length ?? null,
  });

  let recipes = [];

  if (format === "csv") {
    recipes = parseCsvRecipes(bufferToUtf8(file.buffer), sourceLabel);
  } else if (format === "html") {
    recipes = parseHtmlRecipesFromString(bufferToUtf8(file.buffer), sourceLabel);
  } else {
    if (!looksLikeZip(file.buffer)) {
      throw new ImportError(
        "IMPORT_CORRUPTED_ARCHIVE",
        "This backup file appears to be corrupted and could not be read."
      );
    }
    recipes = await parseArchiveFormat(file.buffer, sourceLabel);
  }

  const uniqueRecipes = recipes.filter((recipe, index, arr) => {
    const fingerprint = `${recipe.title.toLowerCase()}::${recipe.ingredients.join("|").toLowerCase()}`;
    return (
      arr.findIndex((candidate) => {
        const other = `${candidate.title.toLowerCase()}::${candidate.ingredients.join("|").toLowerCase()}`;
        return other === fingerprint;
      }) === index
    );
  });

  validateRecipeBatch(uniqueRecipes);

  console.log("[ImportFromFile] parse success", {
    format,
    count: uniqueRecipes.length,
  });

  return {
    format,
    count: uniqueRecipes.length,
    recipes: uniqueRecipes,
    limits: {
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
      maxRecipes: MAX_IMPORT_RECIPES,
    },
  };
}

export async function parseImportedRecipes(file) {
  try {
    return await withTimeout(parseImportedRecipesInner(file), PARSE_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof ImportError) throw err;
    if (err?.code === "Z_DATA_ERROR" || err?.code === "ERR_INVALID_ARG_TYPE") {
      throw new ImportError(
        "IMPORT_CORRUPTED_ARCHIVE",
        "This backup file appears to be corrupted and could not be read."
      );
    }
    throw new ImportError(
      "IMPORT_FAILED",
      "The selected file could not be imported. Please verify the format and try again.",
      500
    );
  }
}

export function toImportErrorResponse(err) {
  if (err instanceof ImportError) {
    return {
      statusCode: err.statusCode,
      body: {
        ok: false,
        code: err.code,
        message: err.message,
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      ok: false,
      code: "IMPORT_FAILED",
      message: "The selected file could not be imported. Please verify the format and try again.",
    },
  };
}
