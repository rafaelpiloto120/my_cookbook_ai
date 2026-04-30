import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import he from "he";

const URL_IMPORT_TELEMETRY_PATH = path.join(process.cwd(), "url-import-events.log");

function safeAppendTelemetryLine(payload) {
  try {
    fs.appendFileSync(URL_IMPORT_TELEMETRY_PATH, `${JSON.stringify(payload)}\n`);
  } catch {
    // best effort only
  }
}

export function recordUrlImportTelemetry({
  url,
  host,
  status,
  stage,
  extractor = null,
  reason = null,
  looksRecipeLike = null,
}) {
  safeAppendTelemetryLine({
    ts: new Date().toISOString(),
    url,
    host,
    status,
    stage,
    extractor,
    reason,
    looksRecipeLike,
  });
}

export function extractJsonLd(html) {
  const $ = cheerio.load(html);
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
      // ignore malformed JSON-LD
    }
  });
  return recipes;
}

function cleanIngredient(str) {
  let out = he.decode(String(str || "")).trim();
  out = out.replace(/\s+/g, " ");
  out = out.replace(/\b(tbsp|tsp|cup|cups|g|kg|ml|l)\s+\1\b/gi, "$1");
  out = out.replace(/\btbsp\b/gi, "tbsp");
  out = out.replace(/\btsp\b/gi, "tsp");
  out = out.replace(/\bcups?\b/gi, (m) => m.toLowerCase());
  return out;
}

function parseDuration(str) {
  if (typeof str === "number" && Number.isFinite(str)) return str;
  if (typeof str !== "string") return null;
  let match = str.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
  if (match) {
    const hours = match[1] ? parseInt(match[1], 10) : 0;
    const mins = match[2] ? parseInt(match[2], 10) : 0;
    return hours * 60 + mins;
  }
  let total = 0;
  const hourMatches = [...str.matchAll(/(\d+)\s*(?:h|hr|hour)s?/gi)];
  for (const m of hourMatches) total += parseInt(m[1], 10) * 60;
  const minMatches = [...str.matchAll(/(\d+)\s*(?:m|min|minute|minutes)/gi)];
  for (const m of minMatches) total += parseInt(m[1], 10);
  if (total > 0) return total;
  match = str.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function extractServings(str) {
  if (typeof str !== "string") return null;
  let match =
    str.match(/\b(\d{1,4})\s*(servings?|people|persons?|porções?|porcao|doses?|dose|comensales|comensais|raciones?)\b/i) ||
    str.match(/\b(serves?|makes?)\s+(\d{1,4})\b/i) ||
    str.match(/\bfor\s+(\d{1,4})\b/i) ||
    str.match(/\b(\d{1,4})\s*(comensales|comensais)\b/i);
  if (match) {
    const numericCapture = match.slice(1).find((value) => /^\d{1,4}$/.test(String(value || "").trim()));
    return numericCapture ? parseInt(numericCapture, 10) : null;
  }
  const justNumber = str.match(/(\d{1,4})/);
  return justNumber ? parseInt(justNumber[1], 10) : null;
}

function normalizeImportedRecipe(scraped, requestInfo) {
  let cookingTime = 30;
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

  let difficulty =
    typeof scraped.difficulty === "string" && scraped.difficulty.trim()
      ? scraped.difficulty.trim()
      : "Moderate";

  let servings;
  let candidateServings = null;
  if (typeof scraped.yield === "string") {
    candidateServings = extractServings(scraped.yield);
  }
  if ((candidateServings === null || Number.isNaN(candidateServings)) && typeof scraped.recipeYield === "string") {
    candidateServings = extractServings(scraped.recipeYield);
  }
  if (typeof candidateServings === "number" && candidateServings > 0 && candidateServings < 1000) {
    servings = candidateServings;
  }
  if (typeof servings !== "number" || !Number.isFinite(servings) || servings <= 0 || servings >= 1000) {
    servings = 4;
  }

  let image;
  if (scraped.image) {
    if (typeof scraped.image === "string" && scraped.image.trim()) {
      const imgVal = scraped.image.trim();
      if (/^https?:\/\//i.test(imgVal)) {
        image = imgVal;
      }
    } else if (Array.isArray(scraped.image) && scraped.image.length > 0) {
      const candidate = scraped.image.find((img) => typeof img === "string" && /^https?:\/\//i.test(img.trim()));
      if (typeof candidate === "string") image = candidate.trim();
    } else if (
      typeof scraped.image === "object" &&
      scraped.image &&
      typeof scraped.image.url === "string" &&
      /^https?:\/\//i.test(scraped.image.url.trim())
    ) {
      image = scraped.image.url.trim();
    }
  }
  if (!image || typeof image !== "string" || !image.trim()) {
    image = `${requestInfo.protocol}://${requestInfo.host}/assets/default_recipe.png`;
  }

  let ingredients = [];
  if (Array.isArray(scraped.ingredients)) {
    ingredients = scraped.ingredients
      .filter(
        (i) =>
          typeof i === "string" &&
          i.trim() &&
          !i.toLowerCase().includes("http") &&
          !i.toLowerCase().includes("base64")
      )
      .map((i) => cleanIngredient(i));
  }
  if (!ingredients.length && Array.isArray(scraped.recipeIngredient)) {
    ingredients = scraped.recipeIngredient
      .filter(
        (i) =>
          typeof i === "string" &&
          i.trim() &&
          !i.toLowerCase().includes("http") &&
          !i.toLowerCase().includes("base64")
      )
      .map((i) => cleanIngredient(i));
  }
  if (!ingredients.length) ingredients = ["No ingredients provided"];

  let steps = [];
  if (Array.isArray(scraped.recipeInstructions) && scraped.recipeInstructions.length > 0) {
    const extracted = [];
    for (const ins of scraped.recipeInstructions) {
      if (typeof ins === "string" && ins.trim()) extracted.push(ins.trim());
      else if (ins && typeof ins === "object" && typeof ins.text === "string" && ins.text.trim()) extracted.push(ins.text.trim());
    }
    if (extracted.length) steps = extracted;
  }
  if (!steps.length && Array.isArray(scraped.instructions)) {
    steps = scraped.instructions.filter((s) => typeof s === "string" && s.trim() && !s.toLowerCase().includes("http"));
  }
  if (!steps.length && typeof scraped.instructions === "string" && scraped.instructions.trim() && !scraped.instructions.toLowerCase().includes("http")) {
    steps = [scraped.instructions.trim()];
  }
  if (!steps.length) steps = ["No steps provided"];
  steps = steps.map((s) => he.decode(s.trim()));

  let tags = [];
  if (typeof scraped.keywords === "string" && scraped.keywords.trim()) {
    tags = scraped.keywords.split(",").map((t) => he.decode(t.trim())).filter(Boolean);
  }
  if (Array.isArray(tags)) {
    tags = Array.from(
      new Set(
        tags
          .map((t) => t.toString().trim().toLowerCase().replace(/[^a-z0-9\s]/gi, ""))
          .filter(Boolean)
          .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
      )
    )
      .filter((t) => t.length <= 50)
      .slice(0, 5);
  }

  return {
    id: `${Date.now()}`,
    title:
      typeof scraped.name === "string" && scraped.name.trim()
        ? he.decode(scraped.name.trim())
        : typeof scraped.title === "string" && scraped.title.trim()
          ? he.decode(scraped.title.trim())
          : "Untitled Recipe",
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

function looksRecipeLikeHtml($) {
  const bodyText = $("body").text().replace(/\s+/g, " ").trim().toLowerCase();
  const hasIngredientSignal =
    /\bingredientes?\b|\bingredients?\b|\bingrédients\b|\bzutaten\b/.test(bodyText);
  const hasMethodSignal =
    /\bpréparation\b|\bpreparation\b|\bprepara[cç][aã]o\b|\binstructions?\b|\bmethod\b|\bzubereitung\b/.test(bodyText);
  const hasYieldOrTimeSignal =
    /\bpor[cç][õo]es\b|\bservings?\b|\bserves\b|\bdoses?\b|\bprep\b|\bcook\b|\b\d{1,3}\s*min\b/.test(bodyText);
  return (hasIngredientSignal && hasMethodSignal) || (hasIngredientSignal && hasYieldOrTimeSignal);
}

function collectSectionItemsByHeading($, headingRegex, stopHeadingRegex, mode = "ingredients") {
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

  if (!heading || !heading.length) return items;

  const pushItem = (rawText) => {
    const text = String(rawText || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    const normalized = mode === "ingredients" ? cleanIngredient(text) : he.decode(text).trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    items.push(normalized);
  };

  let current = heading.next();
  let siblingSteps = 0;
  while (current && current.length && siblingSteps < 120) {
    siblingSteps += 1;
    const nodeName = (current.get(0)?.tagName || "").toLowerCase();
    const text = current.text().replace(/\s+/g, " ").trim();

    if (stopHeadingRegex.test(text) && !headingRegex.test(text)) {
      break;
    }

    if (nodeName === "ul" || nodeName === "ol") {
      current.find("li").each((_, li) => pushItem($(li).text()));
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
}

function extractContinenteRecipe($) {
  const title = he.decode($("h1").first().text().trim());
  const collectSectionItems = (headingRegex, mode = "ingredients") => {
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
    if (!heading || !heading.length) return items;

    const pushItem = (rawText) => {
      const text = String(rawText || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      if (/^adicionar à lista de compras$/i.test(text)) return;
      if (/^gostou desta receita\??$/i.test(text)) return;
      if (/^avalie esta receita$/i.test(text)) return;
      const normalized = mode === "ingredients" ? cleanIngredient(text) : he.decode(text).trim();
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
        !headingRegex.test(text)
      ) {
        break;
      }
      if (/^adicionar à lista de compras$/i.test(text)) break;
      if (nodeName === "ul" || nodeName === "ol") {
        current.find("li").each((_, li) => pushItem($(li).text()));
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

  let ingredients = collectSectionItems(/^ingredientes$/i, "ingredients");
  let steps = collectSectionItems(/^prepara[cç][aã]o$/i, "steps");

  if (!ingredients.length) {
    $("[class*='ingredient' i] li").each((_, el) => {
      const txt = $(el).text().trim();
      if (txt) {
        const cleaned = cleanIngredient(txt);
        if (cleaned) ingredients.push(cleaned);
      }
    });
  }

  if (!steps.length) {
    $("[class*='step' i] li, [class*='step' i] p").each((_, el) => {
      const txt = $(el).text().trim();
      if (txt) steps.push(he.decode(txt));
    });
  }

  if (!(ingredients.length || steps.length)) return null;

  const bodyText = $("body").text();
  const servingsText = bodyText.match(/(\d{1,3})\s+por[cç][õo]es/i);
  const timeMatch = bodyText.match(/(?:Prep:\s*)?(\d{1,3})\s*min/i);
  const scraped = {
    name: title,
    ingredients,
    instructions: steps,
  };
  if (servingsText) scraped.yield = servingsText[1];
  if (timeMatch) scraped.totalTime = parseInt(timeMatch[1], 10);
  return scraped;
}

function extractAllrecipesRecipe($) {
  const title = he.decode($("h1").first().text().trim());

  let ingredients = [];
  $("[data-testid*='ingredient'] li, [data-testid*='ingredients'] li, [data-ingredient-name='true'], .mntl-structured-ingredients__list-item, .recipe__ingredients li").each(
    (_, el) => {
      const txt = $(el).text().trim();
      if (txt) ingredients.push(cleanIngredient(txt));
    }
  );

  if (!ingredients.length) {
    ingredients = collectSectionItemsByHeading(
      $,
      /^ingredients$/i,
      /^(directions|instructions|method|nutrition facts|reviews?)$/i,
      "ingredients"
    );
  }

  let steps = [];
  $("[data-testid*='recipe-directions'] li, [data-testid*='directions'] li, .comp.recipe__steps-content li, .comp.recipe__steps-content p, .recipe__steps li").each(
    (_, el) => {
      const txt = $(el).text().trim();
      if (txt) steps.push(he.decode(txt));
    }
  );

  if (!steps.length) {
    steps = collectSectionItemsByHeading(
      $,
      /^(directions|instructions|method)$/i,
      /^(nutrition facts|reviews?|tips)$/i,
      "steps"
    );
  }

  if (!(ingredients.length || steps.length)) return null;

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const totalTimeMatch = bodyText.match(/Total Time:\s*([^\n]+?)(?:Servings:|$)/i);
  const servingsMatch = bodyText.match(/Servings:\s*(\d{1,3})/i);

  const scraped = {
    name: title,
    ingredients,
    instructions: steps,
  };
  if (totalTimeMatch) {
    const mins = parseDuration(totalTimeMatch[1]);
    if (mins) scraped.totalTime = mins;
  }
  if (servingsMatch) scraped.yield = servingsMatch[1];
  return scraped;
}

function extractBbcGoodFoodRecipe($) {
  const title = he.decode($("h1").first().text().trim());
  const ingredients = [];
  $("#recipe-ingredients li").each((_, el) => {
    const txt = $(el).text().trim();
    if (txt) ingredients.push(cleanIngredient(txt));
  });
  const steps = [];
  $("#method li, #method p").each((_, el) => {
    const txt = $(el).text().trim();
    if (txt) steps.push(he.decode(txt));
  });
  if (!(ingredients.length || steps.length)) return null;
  const servingsText = $("section.recipe-details__item--servings").first().text().trim();
  const match = servingsText.match(/(\d+)/);
  const scraped = { name: title, ingredients, instructions: steps };
  if (match) scraped.yield = match[1];
  return scraped;
}

function extractFoodNetworkUkRecipe($) {
  const title = he.decode($("h1").first().text().trim());
  let ingredients = [];
  $(".ingredients__list li, [data-element-type='ingredients'] li, .recipe-ingredients li").each((_, el) => {
    const txt = $(el).text().trim();
    if (txt) ingredients.push(he.decode(txt));
  });
  ingredients = Array.from(new Set(ingredients.map((s) => s && s.trim()).filter(Boolean))).map((i) => cleanIngredient(i));

  let steps = [];
  $(".method__list li, .method__list p, [data-element-type='method-step'], .method__steps li, .recipe-method li, .method p, .instructions li, .instructions p, [itemprop='recipeInstructions'] li, [itemprop='recipeInstructions'] p, [itemprop='recipeInstructions'] span, .directions li, .directions p").each((_, el) => {
    const txt = $(el).text();
    if (txt && txt.trim()) steps.push(he.decode(txt).trim());
  });
  steps = Array.from(new Set(steps.map((s) => s && s.trim()).filter(Boolean)));
  if (!steps.length) {
    $("ol li, ul li").each((_, el) => {
      const txt = $(el).text();
      if (txt && txt.trim()) steps.push(he.decode(txt).trim());
    });
    steps = Array.from(new Set(steps.map((s) => s && s.trim()).filter(Boolean)));
  }
  if (!(ingredients.length || steps.length)) return null;

  let cookingTime = 30;
  const metaTime = $(".recipe-meta li").map((_, el) => $(el).text()).get().join(" ");
  const parsed = parseDuration(metaTime);
  if (parsed && parsed >= 5) cookingTime = parsed;
  return { name: title, ingredients, instructions: steps, totalTime: cookingTime };
}

function extractCyberCookRecipe($, url) {
  const title = he.decode($("h1").first().text().trim());
  let ingredients = [];
  $(".ingredientes li, .ingredientes-item, [itemprop='recipeIngredient']").each((_, el) => {
    const txt = $(el).text().trim();
    if (txt) ingredients.push(cleanIngredient(txt));
  });
  ingredients = Array.from(new Set(ingredients.filter(Boolean)));
  let steps = [];
  $(".preparo li, .preparo-item, [itemprop='recipeInstructions'], .preparo p, .modo-preparo p").each((_, el) => {
    const txt = $(el).text().trim();
    if (txt) steps.push(he.decode(txt));
  });
  steps = Array.from(new Set(steps.filter(Boolean)));
  if (!(ingredients.length || steps.length)) return null;

  let servings;
  const servingsText =
    $(".yield").first().text().trim() ||
    $("[itemprop='recipeYield']").first().text().trim() ||
    $("[class*=porc]").first().text().trim() ||
    $("[class*=dose]").first().text().trim() ||
    $("[class*=serve]").first().text().trim() ||
    $("body").text();
  const extractedServings = extractServings(servingsText);
  if (typeof extractedServings === "number" && extractedServings > 0 && extractedServings < 1000) {
    servings = extractedServings;
  }

  let image = $("meta[property='og:image']").attr("content") || null;
  if (!image) {
    let imgEl = $(".recipe-photo img, .foto-receita img, img[itemprop='image'], .card-recipe img, .recipe-image img, img").first();
    if (imgEl.length) {
      image = imgEl.attr("src") || imgEl.attr("data-src") || imgEl.attr("data-lazy-src") || imgEl.attr("srcset") || null;
    }
  }
  if (image && image.includes(",")) image = image.split(",")[0].split(/\s+/)[0];
  if (image && !/^https?:\/\//i.test(image)) {
    try {
      image = new URL(image, new URL(url).origin).href;
    } catch {
      image = undefined;
    }
  }

  const scraped = { name: title, ingredients, instructions: steps, image };
  if (servings) scraped.yield = servings.toString();
  return scraped;
}

function extractReceitasNestleRecipe($, url) {
  const title = he.decode($("h1").first().text().trim());
  let ingredients = [];
  $(".recipe-ingredients li, .ingredients__list li, [itemprop='recipeIngredient']").each((_, el) => {
    const txt = $(el).text().trim();
    if (txt) ingredients.push(cleanIngredient(txt));
  });
  ingredients = Array.from(new Set(ingredients.filter(Boolean)));
  let steps = [];
  $("#cook .cookSteps__item li .text, #cook .cookSteps__item li, #cook .cookSteps__item p").each((_, el) => {
    let txt = $(el).text();
    if (txt) {
      txt = txt.replace(/^\s*\d+[\).\s-]*/, "").trim();
      const decoded = he.decode(txt);
      if (decoded) steps.push(decoded);
    }
  });
  steps = Array.from(new Set(steps.filter(Boolean)));
  if (!(ingredients.length || steps.length)) return null;

  let servings;
  const servingsText =
    $(".recipeDetail__infoItem--serving span").first().text().trim() ||
    $(".recipeDetail__infoItem--serving").first().find("span").first().text().trim() ||
    $("strong:contains('Porções')").parent().text().trim();
  const match = servingsText.match(/(\d{1,4})/);
  if (match) servings = parseInt(match[1], 10);
  let cookingTime;
  const timeText = $(".recipe-info__time, .recipe-time").first().text().trim();
  if (timeText) {
    const m = timeText.match(/(\d+)/);
    if (m) cookingTime = parseInt(m[1], 10);
  }
  let image = $("meta[property='og:image']").attr("content") || null;
  if (!image) {
    let imgEl = $("img[loading='eager'], img").first();
    if (imgEl.length) image = imgEl.attr("src") || imgEl.attr("data-src") || imgEl.attr("data-original") || imgEl.attr("srcset") || null;
  }
  if (image && image.includes(",")) image = image.split(",")[0].split(/\s+/)[0];
  if (image && !/^https?:\/\//i.test(image)) {
    try {
      image = new URL(image, new URL(url).origin).href;
    } catch {
      // ignore
    }
  }
  const scraped = { name: title, ingredients, instructions: steps, image };
  if (servings) scraped.yield = servings.toString();
  if (cookingTime) scraped.totalTime = cookingTime;
  return scraped;
}

function extractRecetasGratisRecipe($, url) {
  const title = he.decode($("h1").first().text().trim());
  let ingredients = [];
  $(".ingredientes li, .ingredientes-item, [itemprop='recipeIngredient']").each((_, el) => {
    const txt = $(el).text().trim();
    if (txt) ingredients.push(cleanIngredient(txt));
  });
  ingredients = Array.from(new Set(ingredients.filter(Boolean)));
  let steps = [];
  $(".preparacion li, .preparacion p, [itemprop='recipeInstructions']").each((_, el) => {
    const txt = $(el).text().trim();
    if (txt) steps.push(he.decode(txt));
  });
  steps = Array.from(new Set(steps.filter(Boolean))).map((s, i) => `${i + 1}. ${s}`);
  if (!(ingredients.length || steps.length)) return null;
  let servings;
  const servingsText = $(".property.comensales").first().text().trim();
  const match = servingsText.match(/(\d+)/);
  if (match) servings = parseInt(match[1], 10);
  let image = $("meta[property='og:image']").attr("content") || null;
  if (!image) {
    const imgEl = $("img").first();
    if (imgEl && imgEl.attr("src")) image = new URL(imgEl.attr("src"), url).href;
  }
  const scraped = { name: title, ingredients, instructions: steps, image };
  if (servings) scraped.yield = servings.toString();
  return scraped;
}

function extractTudogostosoRecipe($) {
  const title = he.decode($("h1").first().text().trim());
  let ingredients = [];
  $("[class*='ingrediente' i]").each((_, el) => {
    if ($(el).is("li") || $(el).is("span") || $(el).is("p") || $(el).is("div")) {
      const txt = $(el).text().trim();
      if (txt) {
        const cleaned = cleanIngredient(txt);
        if (cleaned) ingredients.push(cleaned);
      }
    }
  });
  ingredients = Array.from(new Set(ingredients.filter(Boolean)));
  let steps = [];
  const preparoHeader = $("h2:contains('Modo de preparo'), h3:contains('Modo de preparo')").first();
  if (preparoHeader.length) {
    let current = preparoHeader.next();
    while (current.length) {
      if (current.is("h2, h3")) break;
      if (current.is("p, li")) {
        const txt = current.text().trim();
        if (txt) steps.push(he.decode(txt));
      }
      current = current.next();
    }
  }
  if (!steps.length) {
    $("#preparoModo li, #preparoModo p, [class*='preparo' i] li, [class*='preparo' i] p").each((_, el) => {
      const txt = $(el).text().trim();
      if (txt) steps.push(he.decode(txt));
    });
  }
  steps = Array.from(new Set(steps.filter(Boolean)));
  if (!(ingredients.length || steps.length)) return null;
  return { name: title, ingredients, instructions: steps };
}

function extractPunchforkRecipe($) {
  const title = he.decode($("h1").first().text().trim());
  if (!title) return null;

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const servingsMatch = bodyText.match(/Serves\s+(\d{1,3})/i);
  const timeMatch = bodyText.match(/(\d+\s*(?:hrs?|hours?)\s*\d*\s*(?:mins?|minutes?)?|\d+\s*(?:mins?|minutes?))/i);

  const ingredients = [];
  $("li").each((_, el) => {
    const txt = $(el).text().replace(/\s+/g, " ").trim();
    if (/^\d/.test(txt) || /^(salt|pepper|olive oil|water)\b/i.test(txt)) {
      ingredients.push(cleanIngredient(txt));
    }
  });

  const uniqueIngredients = Array.from(new Set(ingredients.filter(Boolean)));
  if (!uniqueIngredients.length) return null;

  const scraped = {
    name: title,
    ingredients: uniqueIngredients,
    instructions: [],
  };
  if (servingsMatch) scraped.yield = servingsMatch[1];
  if (timeMatch) {
    const mins = parseDuration(timeMatch[1]);
    if (mins) scraped.totalTime = mins;
  }
  return scraped;
}

function extractChefkochRecipe($) {
  const title = he.decode($("h1").first().text().trim());

  let ingredients = [];
  const ingredientNodes = [];
  $("h2, h3").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (/zutaten/i.test(text)) {
      let current = $(el).next();
      let safety = 0;
      while (current && current.length && safety < 80) {
        safety += 1;
        const blockText = current.text().replace(/\s+/g, " ").trim();
        if (/^(nährwerte|zubereitung|rezeptautor)/i.test(blockText)) break;
        ingredientNodes.push(blockText);
        current = current.next();
      }
    }
  });

  if (ingredientNodes.length) {
    const filtered = ingredientNodes
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((text) => !/^(für \d+ portionen|weniger|mehr|auf die einkaufsliste setzen)$/i.test(text));

    for (let i = 0; i < filtered.length; i += 2) {
      const qty = filtered[i];
      const name = filtered[i + 1];
      if (!name) continue;
      const combined = `${qty} ${name}`.trim();
      ingredients.push(cleanIngredient(combined));
    }
  }

  let steps = [];
  const prepHeading = $("h2, h3").filter((_, el) => /zubereitung/i.test($(el).text())).first();
  if (prepHeading.length) {
    let current = prepHeading.next();
    let safety = 0;
    let pendingStepNumber = false;
    while (current && current.length && safety < 120) {
      safety += 1;
      const text = current.text().replace(/\s+/g, " ").trim();
      if (!text) {
        current = current.next();
        continue;
      }
      if (/^(rezeptautor|weitere rezepte|ähnliche rezepte|kommentare)/i.test(text)) break;
      if (/^\d+$/.test(text)) {
        pendingStepNumber = true;
        current = current.next();
        continue;
      }
      if (pendingStepNumber || /^schritt\s*\d+/i.test(text)) {
        steps.push(he.decode(text));
        pendingStepNumber = false;
      }
      current = current.next();
    }
  }

  if (!(ingredients.length || steps.length)) return null;

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const servingsMatch = bodyText.match(/Für\s+(\d{1,3})\s+Portionen/i);
  const totalTimeMatch =
    bodyText.match(/(\d{1,3}\s*Min\.)\s*Gesamtzeit/i) ||
    bodyText.match(/Gesamtzeit\s+(\d{1,3}\s*Min\.)/i);
  const workTimeMatch =
    bodyText.match(/(\d{1,3}\s*Min\.)\s*Arbeitszeit/i) ||
    bodyText.match(/Arbeitszeit\s+(\d{1,3}\s*Min\.)/i);
  const cookTimeMatch =
    bodyText.match(/(\d{1,3}\s*Min\.)\s*Koch-\/Backzeit/i) ||
    bodyText.match(/Koch-\/Backzeit\s+(\d{1,3}\s*Min\.)/i);

  const scraped = {
    name: title,
    ingredients,
    instructions: steps,
  };
  if (servingsMatch) scraped.yield = servingsMatch[1];
  if (totalTimeMatch) {
    const mins = parseDuration(totalTimeMatch[1]);
    if (mins) scraped.totalTime = mins;
  } else {
    const workMins = workTimeMatch ? parseDuration(workTimeMatch[1]) : null;
    const cookMins = cookTimeMatch ? parseDuration(cookTimeMatch[1]) : null;
    if (workMins || cookMins) scraped.totalTime = (workMins || 0) + (cookMins || 0);
  }
  return scraped;
}

function extractGenericRecipe($) {
  const genTitle = he.decode($("h1").first().text().trim() || $("title").text().trim());
  let genIngredients = [];
  $("[itemprop='recipeIngredient'], .ingredients li, .ingredientes li, .zutaten li, .ingrédients li").each((_, el) => {
    const txt = $(el).text().trim();
    if (txt) genIngredients.push(cleanIngredient(txt));
  });
  let genSteps = [];
  $("[itemprop='recipeInstructions'], .method li, .preparation li, .zubereitung li, .préparation li").each((_, el) => {
    const txt = $(el).text().trim();
    if (txt) genSteps.push(he.decode(txt));
  });
  if (!(genIngredients.length || genSteps.length)) return null;
  return { name: genTitle, ingredients: genIngredients, instructions: genSteps };
}

export function extractRecipeFromHtml({ url, html, requestInfo }) {
  const $ = cheerio.load(html);
  const ldRecipes = extractJsonLd(html);
  if (ldRecipes.length > 0) {
    return {
      recipe: normalizeImportedRecipe(ldRecipes[0], requestInfo),
      extractor: "jsonld",
      stage: "jsonld",
      looksRecipeLike: true,
    };
  }

  const extractors = [
    { match: /allrecipes\.com/i, id: "allrecipes", run: () => extractAllrecipesRecipe($) },
    { match: /feed\.continente\.pt/i, id: "continente", run: () => extractContinenteRecipe($) },
    { match: /bbcgoodfood\.com/i, id: "bbcgoodfood", run: () => extractBbcGoodFoodRecipe($) },
    { match: /foodnetwork\.co\.uk/i, id: "foodnetwork_uk", run: () => extractFoodNetworkUkRecipe($) },
    { match: /cybercook\.com\.br/i, id: "cybercook", run: () => extractCyberCookRecipe($, url) },
    { match: /receitasnestle\.com\.br/i, id: "receitas_nestle", run: () => extractReceitasNestleRecipe($, url) },
    { match: /recetasgratis\.net/i, id: "recetas_gratis", run: () => extractRecetasGratisRecipe($, url) },
    { match: /chefkoch\.de/i, id: "chefkoch", run: () => extractChefkochRecipe($) },
    { match: /tudogostoso\.com\.br/i, id: "tudogostoso", run: () => extractTudogostosoRecipe($) },
    { match: /punchfork\.com/i, id: "punchfork", run: () => extractPunchforkRecipe($) },
  ];

  for (const extractor of extractors) {
    if (!extractor.match.test(url)) continue;
    const scraped = extractor.run();
    if (scraped) {
      return {
        recipe: normalizeImportedRecipe(scraped, requestInfo),
        extractor: extractor.id,
        stage: "domain",
        looksRecipeLike: true,
      };
    }
  }

  const generic = extractGenericRecipe($);
  if (generic) {
    return {
      recipe: normalizeImportedRecipe(generic, requestInfo),
      extractor: "generic_html",
      stage: "generic",
      looksRecipeLike: true,
    };
  }

  return {
    recipe: null,
    extractor: null,
    stage: "no_match",
    looksRecipeLike: looksRecipeLikeHtml($),
  };
}
