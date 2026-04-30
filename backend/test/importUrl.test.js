import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractRecipeFromHtml } from "../services/importUrl.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "..", "test-fixtures", "url-import");

function loadFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

const requestInfo = {
  protocol: "https",
  host: "api.example.com",
};

test("extractRecipeFromHtml extracts Continente recipe sections", () => {
  const html = loadFixture("continente-recipe.html");
  const result = extractRecipeFromHtml({
    url: "https://feed.continente.pt/receitas/teste",
    html,
    requestInfo,
  });

  assert.equal(result.extractor, "continente");
  assert.equal(result.stage, "domain");
  assert.ok(result.recipe);
  assert.equal(result.recipe.title, "Carne em Vinha d'Alhos à Moda da Madeira");
  assert.equal(result.recipe.servings, 4);
  assert.equal(result.recipe.cookingTime, 45);
  assert.deepEqual(result.recipe.ingredients, [
    "500 g de carne de porco",
    "250 ml de vinho branco",
    "10 ml de vinagre de vinho",
    "1 folha de louro",
    "2 dentes de alho",
    "30 g de banha de porco",
  ]);
  assert.deepEqual(result.recipe.steps, [
    "Corte a carne aos cubos e regue com vinho e vinagre.",
    "Junte o louro, os alhos esmagados e tempere.",
    "Frite a carne até dourar e sirva.",
  ]);
});

test("extractRecipeFromHtml prefers JSON-LD recipe data", () => {
  const html = loadFixture("jsonld-recipe.html");
  const result = extractRecipeFromHtml({
    url: "https://example.com/recipes/creamy-tomato-pasta",
    html,
    requestInfo,
  });

  assert.equal(result.extractor, "jsonld");
  assert.equal(result.stage, "jsonld");
  assert.ok(result.recipe);
  assert.equal(result.recipe.title, "Creamy Tomato Pasta");
  assert.equal(result.recipe.cookingTime, 25);
  assert.equal(result.recipe.servings, 2);
  assert.deepEqual(result.recipe.ingredients, [
    "200 g pasta",
    "2 tomatoes",
    "100 ml cream",
  ]);
  assert.deepEqual(result.recipe.steps, [
    "Cook the pasta.",
    "Make the sauce.",
  ]);
});

test("extractRecipeFromHtml extracts Allrecipes print-style recipe pages", () => {
  const html = loadFixture("allrecipes-print.html");
  const result = extractRecipeFromHtml({
    url: "https://www.allrecipes.com/recipe/23600/worlds-best-lasagna/?print",
    html,
    requestInfo,
  });

  assert.equal(result.extractor, "allrecipes");
  assert.equal(result.stage, "domain");
  assert.ok(result.recipe);
  assert.equal(result.recipe.title, "World's Best Lasagna");
  assert.equal(result.recipe.servings, 12);
  assert.equal(result.recipe.cookingTime, 195);
  assert.deepEqual(result.recipe.steps, [
    "Cook sausage, ground beef, onion, and garlic until browned.",
    "Stir in tomatoes, sauce, paste, and seasonings and simmer.",
    "Layer noodles, ricotta mixture, mozzarella, sauce, and Parmesan.",
    "Bake until browned and let rest before serving.",
  ]);
});

test("extractRecipeFromHtml extracts Chefkoch ingredients and steps", () => {
  const html = loadFixture("chefkoch-carbonara.html");
  const result = extractRecipeFromHtml({
    url: "https://www.chefkoch.de/rezepte/1491131254215808/Spaghetti-Carbonara.html",
    html,
    requestInfo,
  });

  assert.equal(result.extractor, "chefkoch");
  assert.equal(result.stage, "domain");
  assert.ok(result.recipe);
  assert.equal(result.recipe.title, "Spaghetti Carbonara");
  assert.equal(result.recipe.servings, 4);
  assert.equal(result.recipe.cookingTime, 20);
  assert.deepEqual(result.recipe.ingredients, [
    "400 g Spaghetti oder Tortellini",
    "200 g Schinken roher",
    "4 Eigelb",
    "50 g Butter",
    "1 Prise(n) Muskat",
    "n. B. Parmesan, frisch geriebener",
  ]);
  assert.deepEqual(result.recipe.steps, [
    "Die Pasta in reichlich Salzwasser bissfest kochen. Den Schinken in Würfel schneiden und in wenig Butter anbraten.",
    "Eigelb in einer großen Schüssel mit Salz, Pfeffer und Muskat verquirlen. Die Butter schaumig rühren und gut unter das Eigelb mischen.",
    "Wenn die Nudeln gar sind, abgießen, sofort zu der Mischung in die Schüssel geben und servieren.",
  ]);
});

test("extractRecipeFromHtml does not treat generic article as recipe", () => {
  const html = loadFixture("non-recipe-article.html");
  const result = extractRecipeFromHtml({
    url: "https://feed.continente.pt/alimentacao/carne-aberdeen-angus",
    html,
    requestInfo,
  });

  assert.equal(result.recipe, null);
  assert.equal(result.stage, "no_match");
  assert.equal(result.extractor, null);
  assert.equal(result.looksRecipeLike, false);
});
