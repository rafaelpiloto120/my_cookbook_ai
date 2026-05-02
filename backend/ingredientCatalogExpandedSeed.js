const UPDATED_AT = 202605021800;

const LOCALES = ["en", "pt-PT", "pt-BR", "es", "fr", "de"];

function normalizeAlias(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function aliases(en, pt = en, es = en, fr = en, de = en) {
  return {
    en,
    "pt-PT": pt,
    "pt-BR": pt,
    es,
    fr,
    de,
  };
}

function item(id, canonicalName, category, nutritionPer100, defaultServing, localizedAliases) {
  return {
    id,
    canonicalName,
    category,
    nutritionPer100,
    defaultServing,
    aliases: Object.fromEntries(
      LOCALES.map((locale) => [
        locale,
        Array.from(
          new Set(
            (localizedAliases[locale] || localizedAliases.en || [canonicalName])
              .map(normalizeAlias)
              .filter(Boolean)
          )
        ),
      ])
    ),
    source: "seed",
    updatedAt: UPDATED_AT,
  };
}

const VARIANTS = {
  protein: [
    ["grilled", "grelhado", 0.98, 1.02, 1, 0.9],
    ["roasted", "assado", 1.02, 1.02, 1, 1.05],
    ["baked", "no forno", 1, 1, 1, 1],
    ["boiled", "cozido", 0.92, 1, 1, 0.75],
    ["steamed", "a vapor", 0.9, 1, 1, 0.7],
    ["fried", "frito", 1.35, 0.95, 1.15, 1.9],
    ["breaded", "panado", 1.55, 0.85, 6, 2.1],
    ["minced", "picado", 1, 1, 1, 1],
    ["shredded", "desfiado", 0.98, 1, 1, 0.9],
    ["smoked", "fumado", 1.08, 1.02, 1, 1.2],
    ["marinated", "marinado", 1.08, 1, 1.8, 1.15],
    ["stewed", "estufado", 1.18, 0.95, 2.5, 1.5],
    ["with sauce", "com molho", 1.25, 0.9, 4, 1.6],
    ["curry", "caril de", 1.3, 0.9, 5, 1.7],
  ],
  fish: [
    ["grilled", "grelhado", 0.98, 1.02, 1, 0.9],
    ["roasted", "assado", 1.02, 1.02, 1, 1.05],
    ["baked", "no forno", 1, 1, 1, 1],
    ["steamed", "a vapor", 0.9, 1, 1, 0.7],
    ["canned", "enlatado", 1.1, 1.05, 1, 1.15],
    ["fried", "frito", 1.35, 0.95, 1.2, 1.8],
    ["breaded", "panado", 1.5, 0.85, 6, 2],
    ["smoked", "fumado", 1.15, 1.05, 1, 1.2],
    ["salted", "salgado", 1.05, 1.05, 1, 1.05],
    ["marinated", "marinado", 1.08, 1, 1.6, 1.1],
    ["stewed", "estufado", 1.18, 0.95, 2.5, 1.4],
    ["in oil", "em oleo", 1.45, 1, 1, 2.4],
    ["in water", "em agua", 0.95, 1, 1, 0.7],
  ],
  carb: [
    ["cooked", "cozido", 1, 1, 1, 1],
    ["boiled", "cozido", 0.98, 1, 1, 0.8],
    ["baked", "no forno", 1.08, 1, 1.05, 1.2],
    ["roasted", "assado", 1.12, 1, 1.05, 1.25],
    ["mashed", "pure", 1.15, 0.95, 1.05, 1.8],
    ["fried", "frito", 1.85, 0.9, 1.15, 5],
    ["plain", "simples", 1, 1, 1, 1],
    ["whole grain", "integral", 1.02, 1.15, 0.95, 1.05],
    ["creamy", "cremoso", 1.3, 0.95, 1.05, 2.8],
    ["with sauce", "com molho", 1.35, 0.95, 1.15, 2.2],
    ["salted", "salgado", 1.02, 1, 1, 1],
    ["restaurant", "de restaurante", 1.28, 0.95, 1.08, 2.4],
    ["microwave", "de microondas", 1.05, 1, 1, 1.2],
  ],
  vegetable: [
    ["raw", "cru", 1, 1, 1, 1],
    ["cooked", "cozido", 0.95, 1, 1, 0.9],
    ["boiled", "cozido", 0.9, 1, 1, 0.75],
    ["steamed", "a vapor", 0.92, 1, 1, 0.8],
    ["roasted", "assado", 1.25, 1, 1.1, 2.5],
    ["grilled", "grelhado", 1.15, 1, 1.05, 2],
    ["sauteed", "salteado", 1.5, 1, 1.05, 4],
    ["canned", "enlatado", 0.95, 1, 1, 0.8],
    ["frozen", "congelado", 0.98, 1, 1, 1],
    ["pickled", "em conserva", 0.9, 0.9, 0.95, 0.6],
    ["seasoned", "temperado", 1.15, 1, 1.05, 2],
    ["with olive oil", "com azeite", 1.9, 1, 1, 7],
    ["puree", "pure", 1.1, 0.95, 1.05, 1.3],
    ["soup", "sopa de", 0.75, 0.8, 0.8, 0.6],
  ],
  fruit: [
    ["fresh", "fresco", 1, 1, 1, 1],
    ["raw", "cru", 1, 1, 1, 1],
    ["canned", "enlatado", 1.25, 0.9, 1.25, 1],
    ["dried", "seco", 3.1, 2, 3.3, 2.5],
    ["juice", "sumo de", 0.75, 0.5, 0.75, 0.5],
    ["frozen", "congelado", 1, 1, 1, 1],
    ["puree", "pure de", 1.05, 0.9, 1.08, 1],
    ["compote", "compota de", 1.35, 0.8, 1.45, 1],
    ["smoothie", "batido de", 1.15, 1.2, 1.2, 1.4],
    ["jam", "doce de", 4.2, 0.8, 4.8, 1],
  ],
  legume: [
    ["cooked", "cozido", 1, 1, 1, 1],
    ["boiled", "cozido", 0.98, 1, 1, 0.9],
    ["canned", "enlatado", 0.95, 0.95, 0.95, 0.9],
    ["stewed", "estufado", 1.2, 1, 1.05, 2],
    ["puree", "pure", 1.05, 1, 1, 1.2],
    ["salad", "salada de", 1.1, 1, 1, 1.6],
    ["soup", "sopa de", 0.85, 0.85, 0.85, 0.8],
    ["curry", "caril de", 1.35, 0.95, 1.1, 2.5],
    ["with rice", "com arroz", 1.35, 0.85, 1.55, 0.9],
    ["drained", "escorrido", 0.95, 0.95, 0.95, 0.85],
  ],
  dairy: [
    ["plain", "natural", 1, 1, 1, 1],
    ["low fat", "magro", 0.75, 1.1, 1, 0.25],
    ["skim", "magro", 0.6, 1.05, 1, 0.1],
    ["sweetened", "acucarado", 1.25, 0.9, 1.45, 1],
    ["protein", "proteico", 1.15, 2.2, 0.8, 0.7],
    ["lactose free", "sem lactose", 1, 1, 1, 1],
    ["with fruit", "com fruta", 1.2, 0.95, 1.45, 0.9],
    ["vanilla", "baunilha", 1.18, 0.95, 1.35, 0.95],
    ["full fat", "gordo", 1.22, 0.95, 1, 1.55],
    ["drink", "bebida de", 0.75, 0.75, 1, 0.6],
  ],
  nuts: [
    ["raw", "cru", 1, 1, 1, 1],
    ["roasted", "torrado", 1.04, 1, 1, 1.05],
    ["salted", "salgado", 1.03, 1, 1, 1.05],
    ["butter", "manteiga de", 1.06, 1, 0.95, 1.08],
    ["chopped", "picado", 1, 1, 1, 1],
    ["ground", "moido", 1, 1, 1, 1],
    ["flour", "farinha de", 0.95, 1, 0.9, 0.95],
    ["milk", "bebida de", 0.18, 0.18, 0.18, 0.18],
    ["paste", "pasta de", 1.06, 1, 0.95, 1.08],
  ],
  drink: [
    ["unsweetened", "sem acucar", 1, 1, 1, 1],
    ["sweetened", "acucarado", 1.35, 0.9, 1.8, 1],
    ["light", "light", 0.55, 1, 0.5, 1],
    ["zero", "zero", 0.08, 1, 0.05, 1],
    ["bottled", "engarrafado", 1, 1, 1, 1],
    ["homemade", "caseiro", 1, 1, 1, 1],
    ["concentrate", "concentrado", 2.5, 0.8, 2.8, 1],
  ],
  prepared: [
    ["homemade", "caseiro", 1, 1, 1, 1],
    ["restaurant", "de restaurante", 1.18, 1, 1.08, 1.35],
    ["frozen", "congelado", 1.05, 0.95, 1.05, 1.1],
    ["light", "light", 0.78, 1, 0.85, 0.55],
    ["takeaway", "takeaway", 1.22, 1, 1.08, 1.45],
    ["baked", "no forno", 0.95, 1, 0.95, 0.85],
    ["fried", "frito", 1.45, 0.9, 1.15, 2],
    ["with cheese", "com queijo", 1.28, 1.15, 1, 1.65],
    ["with sauce", "com molho", 1.22, 0.95, 1.25, 1.35],
    ["small", "pequeno", 1, 1, 1, 1],
    ["large", "grande", 1, 1, 1, 1],
  ],
  sauce: [
    ["homemade", "caseiro", 1, 1, 1, 1],
    ["light", "light", 0.65, 1, 0.9, 0.45],
    ["creamy", "cremoso", 1.35, 0.95, 1.05, 1.8],
    ["store bought", "de compra", 1.08, 1, 1.1, 1.05],
    ["spicy", "picante", 1.02, 1, 1.02, 1],
    ["garlic", "alho", 1.1, 1, 1.05, 1.25],
    ["herb", "ervas", 1.05, 1, 1.02, 1.1],
    ["yogurt", "iogurte", 0.75, 1.2, 0.9, 0.45],
  ],
};

const BASES = [
  ["turkey_breast", "turkey breast", "protein", 135, 29, 0, 1.5, "g", 150, "g", ["turkey", "turkey breast"], ["peru", "peito de peru"], "protein"],
  ["pork_lion", "pork loin", "protein", 180, 27, 0, 8, "g", 150, "g", ["pork loin", "pork"], ["lombo de porco", "porco"], "protein"],
  ["pork_chop", "pork chop", "protein", 231, 24, 0, 14, "g", 160, "g", ["pork chop"], ["costeleta de porco"], "protein"],
  ["duck_breast", "duck breast", "protein", 201, 23, 0, 11, "g", 150, "g", ["duck", "duck breast"], ["pato", "peito de pato"], "protein"],
  ["lamb", "lamb", "protein", 258, 25, 0, 17, "g", 150, "g", ["lamb"], ["borrego", "cordeiro"], "protein"],
  ["ham", "ham", "protein", 145, 21, 1.5, 6, "g", 60, "g", ["ham"], ["fiambre", "presunto cozido"], "protein"],
  ["bacon", "bacon", "protein", 541, 37, 1.4, 42, "g", 30, "g", ["bacon"], ["bacon", "toucinho"], "protein"],
  ["cod", "cod", "fish", 82, 18, 0, 0.7, "g", 150, "g", ["cod"], ["bacalhau"], "fish"],
  ["hake", "hake", "fish", 86, 18, 0, 1.3, "g", 150, "g", ["hake"], ["pescada"], "fish"],
  ["sardines", "sardines", "fish", 208, 25, 0, 11, "g", 120, "g", ["sardines"], ["sardinhas"], "fish"],
  ["sea_bass", "sea bass", "fish", 124, 23, 0, 3, "g", 150, "g", ["sea bass"], ["robalo"], "fish"],
  ["sea_bream", "sea bream", "fish", 135, 22, 0, 5, "g", 150, "g", ["sea bream"], ["dourada"], "fish"],
  ["shrimp", "shrimp", "fish", 99, 24, 0.2, 0.3, "g", 120, "g", ["shrimp", "prawns"], ["camarao"], "fish"],
  ["squid", "squid", "fish", 92, 16, 3.1, 1.4, "g", 120, "g", ["squid"], ["lulas"], "fish"],
  ["octopus", "octopus", "fish", 82, 15, 2.2, 1, "g", 150, "g", ["octopus"], ["polvo"], "fish"],
  ["mussels", "mussels", "fish", 86, 12, 3.7, 2.2, "g", 120, "g", ["mussels"], ["mexilhoes"], "fish"],
  ["quinoa", "quinoa", "carb", 120, 4.4, 21, 1.9, "g", 150, "g", ["quinoa"], ["quinoa"], "carb"],
  ["couscous", "couscous", "carb", 112, 3.8, 23, 0.2, "g", 150, "g", ["couscous"], ["couscous"], "carb"],
  ["barley", "barley", "carb", 123, 2.3, 28, 0.4, "g", 150, "g", ["barley"], ["cevada"], "carb"],
  ["bulgur", "bulgur", "carb", 83, 3.1, 19, 0.2, "g", 150, "g", ["bulgur"], ["bulgur"], "carb"],
  ["noodles", "noodles", "carb", 138, 4.5, 25, 2.1, "g", 180, "g", ["noodles"], ["noodles", "massa noodles"], "carb"],
  ["gnocchi", "gnocchi", "carb", 133, 3.4, 28, 0.6, "g", 180, "g", ["gnocchi"], ["gnocchi", "nhoque"], "carb"],
  ["naan", "naan", "carb", 310, 9, 54, 7, "g", 70, "g", ["naan", "naan bread"], ["naan", "pao naan"], "carb"],
  ["cornmeal", "cornmeal", "carb", 370, 7, 79, 1.8, "g", 50, "g", ["cornmeal", "polenta"], ["farinha de milho", "polenta"], "carb"],
  ["cassava", "cassava", "carb", 160, 1.4, 38, 0.3, "g", 150, "g", ["cassava", "manioc"], ["mandioca"], "carb"],
  ["pumpkin", "pumpkin", "vegetable", 26, 1, 6.5, 0.1, "g", 150, "g", ["pumpkin"], ["abobora"], "vegetable"],
  ["zucchini", "zucchini", "vegetable", 17, 1.2, 3.1, 0.3, "g", 150, "g", ["zucchini", "courgette"], ["curgete", "courgette"], "vegetable"],
  ["eggplant", "eggplant", "vegetable", 25, 1, 5.9, 0.2, "g", 150, "g", ["eggplant", "aubergine"], ["beringela"], "vegetable"],
  ["cabbage", "cabbage", "vegetable", 25, 1.3, 5.8, 0.1, "g", 120, "g", ["cabbage"], ["couve", "repolho"], "vegetable"],
  ["cauliflower", "cauliflower", "vegetable", 25, 1.9, 5, 0.3, "g", 120, "g", ["cauliflower"], ["couve flor"], "vegetable"],
  ["green_beans", "green beans", "vegetable", 31, 1.8, 7, 0.2, "g", 120, "g", ["green beans"], ["feijao verde"], "vegetable"],
  ["peas", "peas", "vegetable", 81, 5.4, 14, 0.4, "g", 100, "g", ["peas"], ["ervilhas"], "vegetable"],
  ["beetroot", "beetroot", "vegetable", 43, 1.6, 10, 0.2, "g", 100, "g", ["beetroot", "beet"], ["beterraba"], "vegetable"],
  ["asparagus", "asparagus", "vegetable", 20, 2.2, 3.9, 0.1, "g", 100, "g", ["asparagus"], ["espargos"], "vegetable"],
  ["artichoke", "artichoke", "vegetable", 47, 3.3, 11, 0.2, "g", 100, "g", ["artichoke"], ["alcachofra"], "vegetable"],
  ["leek", "leek", "vegetable", 61, 1.5, 14, 0.3, "g", 80, "g", ["leek"], ["alho frances"], "vegetable"],
  ["celery", "celery", "vegetable", 16, 0.7, 3, 0.2, "g", 40, "g", ["celery", "celery stalk"], ["aipo"], "vegetable"],
  ["garlic", "garlic", "vegetable", 149, 6.4, 33, 0.5, "g", 5, "g", ["garlic"], ["alho"], "vegetable"],
  ["apple", "apple", "fruit", 52, 0.3, 14, 0.2, "g", 150, "g", ["apple"], ["maca"], "fruit"],
  ["pear", "pear", "fruit", 57, 0.4, 15, 0.1, "g", 150, "g", ["pear"], ["pera"], "fruit"],
  ["peach", "peach", "fruit", 39, 0.9, 10, 0.3, "g", 150, "g", ["peach"], ["pessego"], "fruit"],
  ["plum", "plum", "fruit", 46, 0.7, 11, 0.3, "g", 120, "g", ["plum"], ["ameixa"], "fruit"],
  ["grapes", "grapes", "fruit", 69, 0.7, 18, 0.2, "g", 100, "g", ["grapes"], ["uvas"], "fruit"],
  ["kiwi", "kiwi", "fruit", 61, 1.1, 15, 0.5, "g", 100, "g", ["kiwi"], ["kiwi"], "fruit"],
  ["pineapple", "pineapple", "fruit", 50, 0.5, 13, 0.1, "g", 120, "g", ["pineapple"], ["ananas", "abacaxi"], "fruit"],
  ["mango", "mango", "fruit", 60, 0.8, 15, 0.4, "g", 120, "g", ["mango"], ["manga"], "fruit"],
  ["watermelon", "watermelon", "fruit", 30, 0.6, 8, 0.2, "g", 200, "g", ["watermelon"], ["melancia"], "fruit"],
  ["melon", "melon", "fruit", 34, 0.8, 8, 0.2, "g", 180, "g", ["melon"], ["melao"], "fruit"],
  ["lemon", "lemon", "fruit", 29, 1.1, 9.3, 0.3, "g", 60, "g", ["lemon", "lime"], ["limao", "lima"], "fruit"],
  ["raspberries", "raspberries", "fruit", 52, 1.2, 12, 0.7, "g", 80, "g", ["raspberries"], ["framboesas"], "fruit"],
  ["blackberries", "blackberries", "fruit", 43, 1.4, 10, 0.5, "g", 80, "g", ["blackberries"], ["amoras"], "fruit"],
  ["lentils", "lentils", "legume", 116, 9, 20, 0.4, "g", 130, "g", ["lentils"], ["lentilhas"], "legume"],
  ["black_beans", "black beans", "legume", 132, 8.9, 24, 0.5, "g", 130, "g", ["black beans"], ["feijao preto"], "legume"],
  ["white_beans", "white beans", "legume", 139, 9.7, 25, 0.4, "g", 130, "g", ["white beans"], ["feijao branco"], "legume"],
  ["red_beans", "red beans", "legume", 127, 8.7, 23, 0.5, "g", 130, "g", ["red beans", "kidney beans"], ["feijao vermelho"], "legume"],
  ["fava_beans", "fava beans", "legume", 110, 7.6, 20, 0.4, "g", 130, "g", ["fava beans", "broad beans"], ["favas"], "legume"],
  ["soybeans", "soybeans", "legume", 172, 16.6, 9.9, 9, "g", 100, "g", ["soybeans"], ["soja"], "legume"],
  ["edamame", "edamame", "legume", 121, 11, 8.9, 5.2, "g", 100, "g", ["edamame"], ["edamame"], "legume"],
  ["cottage_cheese", "cottage cheese", "dairy", 98, 11, 3.4, 4.3, "g", 150, "g", ["cottage cheese"], ["queijo cottage"], "dairy"],
  ["fresh_cheese", "fresh cheese", "dairy", 260, 18, 3, 20, "g", 60, "g", ["fresh cheese"], ["queijo fresco"], "dairy"],
  ["mozzarella", "mozzarella", "dairy", 280, 18, 3.1, 22, "g", 40, "g", ["mozzarella"], ["mozarela"], "dairy"],
  ["feta", "feta", "dairy", 264, 14, 4.1, 21, "g", 40, "g", ["feta"], ["feta"], "dairy"],
  ["ricotta", "ricotta", "dairy", 174, 11, 3, 13, "g", 60, "g", ["ricotta"], ["ricotta"], "dairy"],
  ["cream_cheese", "cream cheese", "dairy", 342, 6, 4, 34, "g", 30, "g", ["cream cheese"], ["queijo creme"], "dairy"],
  ["skyr", "skyr", "dairy", 63, 11, 4, 0.2, "g", 150, "g", ["skyr"], ["skyr"], "dairy"],
  ["almonds", "almonds", "nuts", 579, 21, 22, 50, "g", 30, "g", ["almonds"], ["amendoas"], "nuts"],
  ["walnuts", "walnuts", "nuts", 654, 15, 14, 65, "g", 30, "g", ["walnuts"], ["nozes"], "nuts"],
  ["cashews", "cashews", "nuts", 553, 18, 30, 44, "g", 30, "g", ["cashews"], ["cajus"], "nuts"],
  ["hazelnuts", "hazelnuts", "nuts", 628, 15, 17, 61, "g", 30, "g", ["hazelnuts"], ["avelas"], "nuts"],
  ["pistachios", "pistachios", "nuts", 562, 20, 28, 45, "g", 30, "g", ["pistachios"], ["pistacios"], "nuts"],
  ["peanuts", "peanuts", "nuts", 567, 26, 16, 49, "g", 30, "g", ["peanuts"], ["amendoins"], "nuts"],
  ["sunflower_seeds", "sunflower seeds", "nuts", 584, 21, 20, 51, "g", 25, "g", ["sunflower seeds"], ["sementes de girassol"], "nuts"],
  ["chia_seeds", "chia seeds", "nuts", 486, 17, 42, 31, "g", 15, "g", ["chia seeds"], ["sementes de chia"], "nuts"],
  ["flax_seeds", "flax seeds", "nuts", 534, 18, 29, 42, "g", 15, "g", ["flax seeds"], ["sementes de linhaca"], "nuts"],
  ["pumpkin_seeds", "pumpkin seeds", "nuts", 559, 30, 11, 49, "g", 25, "g", ["pumpkin seeds"], ["sementes de abobora"], "nuts"],
  ["sesame_seeds", "sesame seeds", "nuts", 573, 17, 23, 50, "g", 10, "g", ["sesame seeds"], ["sementes de sesamo"], "nuts"],
  ["mayonnaise", "mayonnaise", "sauce", 680, 1, 1, 75, "g", 15, "g", ["mayonnaise", "mayo"], ["maionese"], "sauce"],
  ["bechamel_sauce", "bechamel sauce", "sauce", 105, 3.5, 8, 6.5, "g", 60, "g", ["bechamel", "bechamel sauce", "white sauce"], ["bechamel", "molho bechamel", "molho branco"], "sauce"],
  ["cream", "cream", "dairy", 340, 2, 3, 35, "ml", 50, "ml", ["cream", "heavy cream", "single cream", "double cream"], ["natas", "nata", "creme de leite"], "dairy"],
  ["ketchup", "ketchup", "sauce", 112, 1.3, 26, 0.2, "g", 20, "g", ["ketchup"], ["ketchup"], "sauce"],
  ["mustard", "mustard", "sauce", 66, 4.4, 5.8, 3.3, "g", 10, "g", ["mustard"], ["mostarda"], "sauce"],
  ["pesto", "pesto", "sauce", 418, 5, 7, 41, "g", 30, "g", ["pesto"], ["pesto"], "sauce"],
  ["hummus", "hummus", "sauce", 166, 8, 14, 10, "g", 50, "g", ["hummus"], ["hummus"], "sauce"],
  ["soy_sauce", "soy sauce", "sauce", 53, 8, 4.9, 0.6, "ml", 15, "ml", ["soy sauce"], ["molho de soja"], "sauce"],
  ["barbecue_sauce", "barbecue sauce", "sauce", 172, 0.8, 40, 0.6, "g", 25, "g", ["barbecue sauce", "bbq sauce"], ["molho barbecue"], "sauce"],
  ["yogurt_sauce", "yogurt sauce", "sauce", 80, 4, 6, 4, "g", 30, "g", ["yogurt sauce"], ["molho de iogurte"], "sauce"],
  ["wine", "wine", "drink", 85, 0.1, 2.6, 0, "ml", 150, "ml", ["wine"], ["vinho"], "drink"],
  ["coconut_cream", "coconut cream", "sauce", 330, 2, 6, 34, "ml", 50, "ml", ["coconut cream", "coconut milk"], ["creme de coco", "leite de coco"], "sauce"],
  ["beer", "beer", "drink", 43, 0.5, 3.6, 0, "ml", 330, "ml", ["beer"], ["cerveja"], "drink"],
  ["almond_milk", "almond milk", "drink", 17, 0.6, 0.7, 1.5, "ml", 200, "ml", ["almond milk"], ["bebida de amendoa"], "drink"],
  ["soy_milk", "soy milk", "drink", 54, 3.3, 6, 1.8, "ml", 200, "ml", ["soy milk"], ["bebida de soja"], "drink"],
  ["oat_milk", "oat milk", "drink", 46, 1, 6.7, 1.5, "ml", 200, "ml", ["oat milk"], ["bebida de aveia"], "drink"],
  ["smoothie", "smoothie", "drink", 65, 1.5, 13, 1, "ml", 250, "ml", ["smoothie"], ["smoothie", "batido"], "drink"],
  ["pizza", "pizza", "prepared", 266, 11, 33, 10, "g", 180, "g", ["pizza"], ["pizza"], "prepared"],
  ["pizza_dough", "pizza dough", "carb", 260, 7, 52, 2.5, "g", 160, "g", ["pizza dough", "pizza base", "pizza crust"], ["massa de pizza", "base de pizza"], "carb"],
  ["wheat_flour", "wheat flour", "carb", 364, 10, 76, 1, "g", 30, "g", ["flour", "wheat flour", "all purpose flour", "plain flour"], ["farinha", "farinha de trigo"], "carb"],
  ["white_sugar", "white sugar", "carb", 387, 0, 100, 0, "g", 10, "g", ["sugar", "white sugar", "granulated sugar"], ["acucar", "acucar branco"], "carb"],
  ["brown_sugar", "brown sugar", "carb", 380, 0, 98, 0, "g", 10, "g", ["brown sugar"], ["acucar mascavado", "acucar amarelo"], "carb"],
  ["lasagna", "lasagna", "prepared", 135, 7, 12, 6, "g", 250, "g", ["lasagna"], ["lasanha"], "prepared"],
  ["lasagna_sheets", "lasagna sheets", "carb", 350, 12, 72, 1.5, "g", 50, "g", ["lasagna sheets", "lasagne sheets", "pasta sheets"], ["folhas de lasanha", "placas de lasanha", "massa de lasanha"], "carb"],
  ["meatballs", "meatballs", "prepared", 197, 13, 7, 12, "g", 150, "g", ["meatballs"], ["almondegas"], "prepared"],
  ["salad", "salad", "vegetable", 40, 2, 7, 0.5, "g", 80, "g", ["salad", "mixed salad"], ["salada", "salada mista"], "vegetable"],
  ["bread_slices", "sliced bread", "carb", 265, 9, 49, 3.2, "g", 30, "g", ["sliced bread", "bread slice", "bread slices"], ["pao de forma", "fatia de pao", "fatias de pao"], "carb"],
  ["puff_pastry", "puff pastry", "carb", 558, 7, 45, 38, "g", 80, "g", ["puff pastry", "shortcrust pastry", "pastry sheet"], ["massa folhada", "massa quebrada"], "carb"],
  ["breadcrumbs", "breadcrumbs", "carb", 395, 13, 72, 5, "g", 30, "g", ["breadcrumbs", "bread crumbs"], ["pao ralado", "farinha de rosca"], "carb"],
  ["ham_slices", "ham slices", "protein", 145, 21, 1.5, 6, "g", 50, "g", ["ham slices", "sliced ham"], ["fatias de fiambre", "fiambre fatiado"], "protein"],
  ["egg_yolk", "egg yolk", "protein", 322, 16, 3.6, 27, "g", 18, "g", ["egg yolk", "egg yolks"], ["gema", "gemas", "gema de ovo", "gemas de ovo"], "protein"],
  ["egg_white", "egg white", "protein", 52, 11, 0.7, 0.2, "g", 33, "g", ["egg white", "egg whites"], ["clara", "claras", "clara de ovo", "claras de ovo"], "protein"],
  ["omelette", "omelette", "prepared", 154, 11, 1, 12, "g", 150, "g", ["omelette"], ["omelete"], "prepared"],
  ["pancakes", "pancakes", "prepared", 227, 6, 28, 10, "g", 120, "g", ["pancakes"], ["panquecas"], "prepared"],
  ["waffles", "waffles", "prepared", 291, 8, 33, 14, "g", 100, "g", ["waffles"], ["waffles"], "prepared"],
  ["croissant", "croissant", "prepared", 406, 8, 45, 21, "g", 70, "g", ["croissant"], ["croissant"], "prepared"],
  ["muffin", "muffin", "prepared", 377, 5, 54, 16, "g", 90, "g", ["muffin"], ["muffin"], "prepared"],
  ["chocolate", "chocolate", "prepared", 546, 4.9, 61, 31, "g", 30, "g", ["chocolate", "chocolate chips"], ["chocolate", "pepitas de chocolate", "gotas de chocolate"], "prepared"],
  ["ice_cream", "ice cream", "prepared", 207, 3.5, 24, 11, "g", 100, "g", ["ice cream", "vanilla ice cream"], ["gelado", "gelado de baunilha"], "prepared"],
  ["protein_bar", "protein bar", "prepared", 350, 25, 35, 10, "g", 60, "g", ["protein bar"], ["barra proteica"], "prepared"],
  ["cereal_bar", "cereal bar", "prepared", 380, 6, 65, 10, "g", 40, "g", ["cereal bar"], ["barra de cereais"], "prepared"],
];

const BASE_LOCALE_ALIASES = {
  pork_lion: {
    es: ["cerdo", "lomo de cerdo", "solomillo de cerdo"],
    fr: ["porc", "filet de porc"],
    de: ["schwein", "schweinefilet", "schweinelende"],
  },
  pork_chop: {
    es: ["chuleta de cerdo", "cerdo"],
    fr: ["cote de porc", "porc"],
    de: ["schweinekotelett", "schwein"],
  },
  ham: {
    es: ["jamon", "jamon cocido", "lonchas de jamon"],
    fr: ["jambon", "jambon cuit", "tranches de jambon"],
    de: ["schinken", "gekochter schinken"],
  },
  cod: {
    es: ["bacalao"],
    fr: ["morue", "cabillaud"],
    de: ["kabeljau", "dorsch"],
  },
  shrimp: {
    es: ["gambas", "camarones", "langostinos"],
    fr: ["crevettes"],
    de: ["garnelen", "shrimps"],
  },
  noodles: {
    es: ["fideos", "pasta", "noodles"],
    fr: ["nouilles", "pates"],
    de: ["nudeln", "pasta"],
  },
  gnocchi: {
    es: ["noquis", "gnocchi"],
    fr: ["gnocchi"],
    de: ["gnocchi"],
  },
  wheat_flour: {
    es: ["harina", "harina de trigo"],
    fr: ["farine", "farine de ble"],
    de: ["mehl", "weizenmehl"],
  },
  white_sugar: {
    es: ["azucar", "azucar blanco"],
    fr: ["sucre", "sucre blanc"],
    de: ["zucker", "weisser zucker"],
  },
  brown_sugar: {
    es: ["azucar moreno", "azucar mascabado"],
    fr: ["sucre roux", "cassonade"],
    de: ["brauner zucker", "rohrzucker"],
  },
  bechamel_sauce: {
    es: ["bechamel", "salsa bechamel", "salsa blanca"],
    fr: ["bechamel", "sauce bechamel", "sauce blanche"],
    de: ["bechamel", "bechamelsosse", "weisse sosse"],
  },
  cream: {
    es: ["nata", "crema", "crema de leche"],
    fr: ["creme", "creme liquide", "creme fraiche"],
    de: ["sahne", "rahm", "schlagsahne"],
  },
  coconut_cream: {
    es: ["crema de coco", "leche de coco"],
    fr: ["creme de coco", "lait de coco"],
    de: ["kokoscreme", "kokosmilch"],
  },
  soy_sauce: {
    es: ["salsa de soja"],
    fr: ["sauce soja"],
    de: ["sojasosse", "sojasauce"],
  },
  sesame_seeds: {
    es: ["semillas de sesamo", "sesamo", "ajonjoli"],
    fr: ["graines de sesame", "sesame"],
    de: ["sesam", "sesamsamen"],
  },
  egg_yolk: {
    es: ["yema", "yemas", "yema de huevo"],
    fr: ["jaune d oeuf", "jaunes d oeuf"],
    de: ["eigelb", "eigelbe"],
  },
  egg_white: {
    es: ["clara", "claras", "clara de huevo"],
    fr: ["blanc d oeuf", "blancs d oeuf"],
    de: ["eiweiss", "eiweisse"],
  },
  feta: {
    es: ["feta", "queso feta"],
    fr: ["feta", "fromage feta"],
    de: ["feta", "fetakase", "feta kase"],
  },
  ricotta: {
    es: ["ricotta", "requeson"],
    fr: ["ricotta"],
    de: ["ricotta"],
  },
  mozzarella: {
    es: ["mozzarella", "queso mozzarella"],
    fr: ["mozzarella"],
    de: ["mozzarella"],
  },
  cream_cheese: {
    es: ["queso crema", "philadelphia"],
    fr: ["fromage frais", "fromage a tartiner", "philadelphia"],
    de: ["frischkase", "philadelphia"],
  },
  spinach: {
    es: ["espinacas", "espinaca"],
    fr: ["epinards", "epinard"],
    de: ["spinat"],
  },
  artichoke: {
    es: ["alcachofa", "alcachofas"],
    fr: ["artichaut", "artichauts"],
    de: ["artischocke", "artischocken"],
  },
  breadcrumbs: {
    es: ["pan rallado"],
    fr: ["chapelure"],
    de: ["paniermehl", "semmelbrosel"],
  },
  chocolate: {
    es: ["chocolate", "pepitas de chocolate"],
    fr: ["chocolat", "pepites de chocolat"],
    de: ["schokolade", "schokoladenstuckchen"],
  },
  ice_cream: {
    es: ["helado", "helado de vainilla"],
    fr: ["glace", "glace vanille"],
    de: ["eis", "vanilleeis"],
  },
};

function scaledNutrition(base, variant) {
  const [, , calorieScale, proteinScale, carbScale, fatScale] = variant;
  const [calories, protein, carbs, fat, unit] = base;
  return {
    calories: Math.max(0, Math.round(calories * calorieScale * 10) / 10),
    protein: Math.max(0, Math.round(protein * proteinScale * 10) / 10),
    carbs: Math.max(0, Math.round(carbs * carbScale * 10) / 10),
    fat: Math.max(0, Math.round(fat * fatScale * 10) / 10),
    unit,
  };
}

function buildVariantAliases(enAliases, ptAliases, variant) {
  const [enPrep, ptPrep] = variant;
  const en = enAliases.flatMap((alias) => [`${enPrep} ${alias}`, `${alias} ${enPrep}`]);
  const pt = ptAliases.flatMap((alias) => [`${alias} ${ptPrep}`, `${ptPrep} ${alias}`]);
  return aliases(en, pt);
}

function buildExpandedItems() {
  const items = [];
  for (const base of BASES) {
    const [
      id,
      canonicalName,
      category,
      calories,
      protein,
      carbs,
      fat,
      unit,
      servingQuantity,
      servingUnit,
      enAliases,
      ptAliases,
      variantKey,
    ] = base;
    const baseNutrition = { calories, protein, carbs, fat, unit };
    const localeAliases = BASE_LOCALE_ALIASES[id] || {};
    items.push(
      item(
        `expanded_${id}`,
        canonicalName,
        category,
        baseNutrition,
        { quantity: servingQuantity, unit: servingUnit },
        aliases(
          enAliases,
          ptAliases,
          localeAliases.es || enAliases,
          localeAliases.fr || enAliases,
          localeAliases.de || enAliases
        )
      )
    );

    for (const variant of VARIANTS[variantKey] || []) {
      const [enPrep] = variant;
      items.push(
        item(
          `expanded_${id}_${enPrep.replace(/\s+/g, "_")}`,
          `${enPrep} ${canonicalName}`,
          category,
          scaledNutrition([calories, protein, carbs, fat, unit], variant),
          { quantity: servingQuantity, unit: servingUnit },
          buildVariantAliases(enAliases, ptAliases, variant)
        )
      );
    }
  }
  return items;
}

export const INGREDIENT_CATALOG_EXPANDED_SEED_ITEMS = buildExpandedItems();
export const INGREDIENT_CATALOG_EXPANDED_SEED_UPDATED_AT = UPDATED_AT;
