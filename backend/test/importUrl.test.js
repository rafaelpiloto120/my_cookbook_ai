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
  assert.deepEqual(result.recipe.nutritionInfo?.perServing, {
    calories: 520,
    protein: 18,
    carbs: 64,
    fat: 21,
  });
  assert.equal(result.recipe.nutritionInfo?.source, "imported_url");
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

test("extractRecipeFromHtml extracts Mundo de Receitas Bimby recipe pages", () => {
  const html = loadFixture("bimby-sopa-camponesa.html");
  const result = extractRecipeFromHtml({
    url: "https://www.mundodereceitasbimby.com.pt/sopas-receitas/sopa-camponesa/tew7x2gx-6f492-685137-cfcd2-rj50u37x",
    html,
    requestInfo,
  });

  assert.equal(result.extractor, "thermomix_community");
  assert.equal(result.stage, "domain");
  assert.ok(result.recipe);
  assert.equal(result.recipe.title, "Sopa camponesa");
  assert.equal(result.recipe.cookingTime, 35);
  assert.equal(result.recipe.servings, null);
  assert.deepEqual(result.recipe.ingredients, [
    "100 g alho porro , cortado às rodelas",
    "50 g nabos , cortado aos pedaços",
    "100 g courgettes , cortado aos pedaços",
    "2 cenoura, s , cortada aos pedaços",
    "100 g batata, s , cortada aos cubos",
    "200 g couve lombardo , cortada aos pedaços",
    "100 g tomate, s , cotado aos pedaços",
    "50 g bacon",
    "600 g água",
    "q.b. sal",
    "½ c. chá ervas frescas",
  ]);
  assert.deepEqual(result.recipe.steps, [
    "Coloque no copo o alho, o nabo, a courgette, a cenoura e programe 6 seg/vel 4.",
    "Adicione os restantes ingredientes e programe 25 min/100ºC/vel 2.",
    "Programe 8 seg/vel 4. Desta forma não desfaz os legumes mas fica mais espessa.",
  ]);
  assert.equal(result.recipe.image, "https://www.mundodereceitasbimby.com.pt/sites/default/files/styles/recipe_main/public/sopa.jpg");
});

test("extractRecipeFromHtml falls back to clean Bimby metadata title when h1 only has actions", () => {
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta property="og:title" content="Puré de batata de Equipa Bimby. Receita Bimby® na categoria Acompanhamentos." />
      </head>
      <body>
        <h1>
          <a href="/node/123/edit">Editar</a>
        </h1>
        <h3>Ingredientes</h3>
        <ul>
          <li>1000 g batatas p/ fritar, descascadas e cortadas aos pedaços</li>
          <li>400 g leite</li>
        </ul>
        <h2>Etapa de preparação</h2>
        <ol>
          <li>Insira a borboleta. Coloque no copo a batata, o leite, o sal e programe 30 min/90°C/vel 1.</li>
        </ol>
      </body>
    </html>
  `;
  const result = extractRecipeFromHtml({
    url: "https://www.mundodereceitasbimby.com.pt/acompanhamentos-receitas/pure-de-batata/xc8p4u99-6f492-496725-cfcd2-by7xi63a",
    html,
    requestInfo,
  });

  assert.equal(result.extractor, "thermomix_community");
  assert.ok(result.recipe);
  assert.equal(result.recipe.title, "Puré de batata");
});

test("extractRecipeFromHtml extracts Thermomix community pages in German", () => {
  const html = loadFixture("rezeptwelt-apfelkuchen.html");
  const result = extractRecipeFromHtml({
    url: "https://www.rezeptwelt.de/backen-suess-rezepte/apfelkuchen/example",
    html,
    requestInfo,
  });

  assert.equal(result.extractor, "thermomix_community");
  assert.equal(result.stage, "domain");
  assert.ok(result.recipe);
  assert.equal(result.recipe.title, "Apfelkuchen");
  assert.equal(result.recipe.cookingTime, 45);
  assert.equal(result.recipe.servings, 10);
  assert.deepEqual(result.recipe.ingredients, [
    "250 g Mehl",
    "120 g Zucker",
    "2 Eier",
    "3 Äpfel",
  ]);
  assert.deepEqual(result.recipe.steps, [
    "Mehl, Zucker und Eier in den Mixtopf geben und verrühren.",
    "Äpfel unterheben und den Teig in eine Form geben.",
    "Backen, bis der Kuchen goldbraun ist.",
  ]);
});

test("extractRecipeFromHtml extracts Thermomix community portion(s) servings in English", () => {
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta property="og:title" content='"Magic Bean" chocolate cake by Sarah Wong. A Thermomix recipe.' />
      </head>
      <body>
        <h1>"Magic Bean" chocolate cake</h1>
        <div>
          Preparation time 5min
          Total time 35min
          Portion
          12 portion(s)
          Level easy
        </div>
        <h3>Ingredients</h3>
        <ul>
          <li>420 g can kidney beans or butter beans, drained and rinsed</li>
          <li>5 eggs</li>
          <li>140 g rapadura or coconut sugar</li>
        </ul>
        <h2>Recipe's preparation</h2>
        <ol>
          <li>Puree the beans, water, 1 egg and vanilla until smooth.</li>
          <li>Pour batter into greased ring tin pan and bake for 30 minutes.</li>
        </ol>
      </body>
    </html>
  `;
  const result = extractRecipeFromHtml({
    url: "https://www.recipecommunity.com.au/baking-sweet-recipes/magic-bean-chocolate-cake/ypc7sbzq-01eb7-187035-cfcd2-ynu6w8ud",
    html,
    requestInfo,
  });

  assert.equal(result.extractor, "thermomix_community");
  assert.ok(result.recipe);
  assert.equal(result.recipe.title, '"Magic Bean" chocolate cake');
  assert.equal(result.recipe.cookingTime, 35);
  assert.equal(result.recipe.servings, 12);
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
