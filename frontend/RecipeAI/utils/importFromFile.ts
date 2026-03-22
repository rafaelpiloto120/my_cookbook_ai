import { Directory, File, Paths } from "expo-file-system";
import { EncodingType, writeAsStringAsync } from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getAuth } from "firebase/auth";
import { getDeviceId } from "./deviceId";
import i18n from "../i18n";

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".rtk", ".paprikarecipes", ".zip", ".html", ".htm", ".csv"];
const MIME_TYPE_TO_EXTENSION: Record<string, string> = {
  "text/csv": ".csv",
  "text/html": ".html",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
  "application/x-zip": ".zip",
  "multipart/x-zip": ".zip",
  "application/octet-stream": ".zip",
};
const DATA_URI_IMAGE_RE =
  /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\n\r]+)$/;

export type ImportedRecipe = {
  id: string;
  title: string;
  cookingTime: number;
  difficulty: "Easy" | "Moderate" | "Challenging";
  servings: number;
  cost: "Cheap" | "Medium" | "Expensive";
  ingredients: string[];
  steps: string[];
  tags: string[];
  createdAt: number | string;
  updatedAt: number | string;
  image?: string;
  imageUrl?: string;
  cookbooks?: (string | { id: string; name: string })[];
  isDeleted?: boolean;
};

export type ImportCookbookTarget = {
  id: string;
  name?: string;
};

type ImportRecipesFromFileOptions = {
  backendUrl: string;
  appEnv?: string;
  cookbook?: ImportCookbookTarget | null;
  syncEngine?: any;
};

type ImportRecipesFromFileResult = {
  count: number;
  recipes: ImportedRecipe[];
  format: string;
  fileName: string;
};

function getExtension(name: string) {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

function getFileNameFromUri(uri: string) {
  const parts = uri.split("/");
  return parts[parts.length - 1] || "import";
}

function getCandidateFileName(file: File): string {
  const runtimeName =
    (file as any)?.name ||
    (file as any)?.fileName ||
    (file as any)?.originalName ||
    (file as any)?._name;

  if (typeof runtimeName === "string" && runtimeName.trim()) {
    return runtimeName.trim();
  }

  return getFileNameFromUri(file.uri);
}

function inferExtension(fileName: string, mimeType?: string | null) {
  const fromName = getExtension(fileName);
  if (fromName) return fromName;

  const normalizedMime = typeof mimeType === "string" ? mimeType.toLowerCase() : "";
  return MIME_TYPE_TO_EXTENSION[normalizedMime] || "";
}

function extensionFromMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  return ".img";
}

async function materializeEmbeddedImage(imageValue: string, recipeId: string): Promise<string> {
  const match = imageValue.match(DATA_URI_IMAGE_RE);
  if (!match) return imageValue;

  const [, mimeType, base64] = match;
  const ext = extensionFromMimeType(mimeType);
  const dir = new Directory(Paths.cache, "imported-recipes");
  if (!dir.exists) {
    dir.create({ idempotent: true, intermediates: true });
  }

  const file = new File(dir, `${recipeId}${ext}`);
  if (!file.exists) {
    file.create({ overwrite: true, intermediates: true });
  }

  await writeAsStringAsync(file.uri, base64.replace(/\s+/g, ""), {
    encoding: EncodingType.Base64,
  });

  return file.uri;
}

function normalizeImportedRecipe(
  raw: ImportedRecipe,
  cookbook?: ImportCookbookTarget | null
): Promise<ImportedRecipe> {
  const now = Date.now();
  const safeCookbooks = cookbook ? [{ id: cookbook.id, name: cookbook.name ?? "" }] : [];
  const recipeId =
    raw?.id ||
    `imp-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const imageValue = raw?.image || raw?.imageUrl || "";

  return Promise.resolve(
    materializeEmbeddedImage(imageValue, recipeId).then((materializedImage) => ({
      id: recipeId,
      title: String(raw?.title || "").trim(),
      cookingTime:
        typeof raw?.cookingTime === "number" && Number.isFinite(raw.cookingTime)
          ? raw.cookingTime
          : 0,
      difficulty:
        raw?.difficulty === "Moderate" || raw?.difficulty === "Challenging"
          ? raw.difficulty
          : "Easy",
      servings:
        typeof raw?.servings === "number" && Number.isFinite(raw.servings)
          ? raw.servings
          : 0,
      cost:
        raw?.cost === "Cheap" || raw?.cost === "Expensive" ? raw.cost : "Medium",
      ingredients: Array.isArray(raw?.ingredients) ? raw.ingredients.filter(Boolean) : [],
      steps: Array.isArray(raw?.steps) ? raw.steps.filter(Boolean) : [],
      tags: Array.isArray(raw?.tags) ? raw.tags.filter(Boolean) : [],
      createdAt: raw?.createdAt ?? now,
      updatedAt: now,
      image: materializedImage || undefined,
      imageUrl: materializedImage || undefined,
      cookbooks: safeCookbooks,
      isDeleted: false,
    }))
  );
}

async function persistImportedRecipes(
  recipes: ImportedRecipe[],
  syncEngine?: any
): Promise<ImportedRecipe[]> {
  const stored = await AsyncStorage.getItem("recipes");
  const current: ImportedRecipe[] = stored ? JSON.parse(stored) : [];
  const next = [...recipes, ...current];

  await AsyncStorage.setItem("recipes", JSON.stringify(next));

  if (syncEngine) {
    if (typeof syncEngine.saveLocalRecipesSnapshot === "function") {
      await syncEngine.saveLocalRecipesSnapshot(next);
    }
    if (typeof syncEngine.markRecipeDirty === "function") {
      for (const recipe of recipes) {
        await syncEngine.markRecipeDirty(recipe);
      }
    }

    if (typeof syncEngine.forceSyncNow === "function") {
      await syncEngine.forceSyncNow("manual");
    } else if (typeof syncEngine.syncAll === "function") {
      try {
        await syncEngine.syncAll("manual", { bypassThrottle: true });
      } catch {
        await syncEngine.syncAll("manual");
      }
    } else if (typeof syncEngine.requestSync === "function") {
      syncEngine.requestSync("manual");
    }
  }

  return next;
}

async function pickImportFile(): Promise<File> {
  const picked = await File.pickFileAsync(undefined, "*/*");
  const file = Array.isArray(picked) ? picked[0] : picked;

  if (!file) {
    throw new Error(
      i18n.t("recipes.file_import_error_no_file", {
        defaultValue: "No file was selected.",
      })
    );
  }

  const fileName = getCandidateFileName(file);
  const ext = inferExtension(fileName, file.type);
  console.log("[ImportFromFile] picked file", {
    uri: file.uri,
    fileName,
    inferredExtension: ext,
    mimeType: file.type || null,
    runtimeName: (file as any)?.name ?? null,
    runtimeFileName: (file as any)?.fileName ?? null,
  });
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(i18n.t("recipes.file_import_error_unsupported", {
      defaultValue:
        "Unsupported file type. Supported formats are .rtk, .paprikarecipes, .zip, .html, and .csv.",
    }));
  }

  const info = file.info();
  const size = typeof info.size === "number" ? info.size : file.size;
  if (typeof size === "number" && size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      i18n.t("recipes.file_import_error_too_large", {
        defaultValue: "This file is too large. The maximum supported size is 25 MB.",
      })
    );
  }

  return file;
}

async function uploadImportFile(
  file: File,
  backendUrl: string,
  appEnv = "local"
): Promise<{ count: number; format: string; recipes: ImportedRecipe[]; fileName: string }> {
  const auth = getAuth();
  const currentUser = auth.currentUser;
  const idToken = currentUser ? await currentUser.getIdToken().catch(() => null) : null;
  const deviceId = await getDeviceId().catch(() => null);
  const userId = currentUser?.uid ?? null;

  const form = new FormData();
  const originalName = getCandidateFileName(file);
  const inferredExt = inferExtension(originalName, file.type);
  const fileName = getExtension(originalName)
    ? originalName
    : inferredExt
    ? `${originalName || "import"}${inferredExt}`
    : originalName || "import";
  const mimeType = file.type || "application/octet-stream";

  console.log("[ImportFromFile] uploading file", {
    uri: file.uri,
    originalName,
    uploadName: fileName,
    inferredExtension: inferredExt,
    mimeType,
  });

  form.append("file", {
    uri: file.uri,
    name: fileName,
    type: mimeType,
  } as any);

  const headers: Record<string, string> = {
    "x-app-env": appEnv,
  };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  if (deviceId) headers["x-device-id"] = deviceId;
  if (userId) headers["x-user-id"] = userId;

  const response = await fetch(`${backendUrl}/importRecipesFromFile`, {
    method: "POST",
    headers,
    body: form,
  });

  const data = await response.json().catch(() => null);

  console.log("[ImportFromFile] backend response", {
    status: response.status,
    ok: response.ok,
    body: data,
  });

  if (!response.ok) {
    throw new Error(
      typeof data?.message === "string"
        ? data.message
        : "The selected file could not be imported."
    );
  }

  return {
    count: typeof data?.count === "number" ? data.count : 0,
    format: typeof data?.format === "string" ? data.format : "unknown",
    recipes: Array.isArray(data?.recipes) ? data.recipes : [],
    fileName,
  };
}

export async function importRecipesFromFile(
  options: ImportRecipesFromFileOptions
): Promise<ImportRecipesFromFileResult> {
  if (!options.backendUrl) {
    throw new Error(
      i18n.t("recipes.file_import_error_backend_missing", {
        defaultValue: "Backend URL is not configured.",
      })
    );
  }

  const pickedFile = await pickImportFile();
  const uploaded = await uploadImportFile(pickedFile, options.backendUrl, options.appEnv ?? "local");
  const normalizedRecipes = await Promise.all(
    uploaded.recipes.map((recipe) => normalizeImportedRecipe(recipe, options.cookbook))
  );

  await persistImportedRecipes(normalizedRecipes, options.syncEngine);

  return {
    count: uploaded.count,
    recipes: normalizedRecipes,
    format: uploaded.format,
    fileName: uploaded.fileName,
  };
}
