import {
  INGREDIENT_CATALOG_EXPANDED_SEED_ITEMS,
  INGREDIENT_CATALOG_EXPANDED_SEED_UPDATED_AT,
} from "./ingredientCatalogExpandedSeed.js";

export const INGREDIENT_CATALOG_SEED_UPDATED_AT = 202604292030;

function item(
  id,
  canonicalName,
  category,
  nutritionPer100,
  defaultServing,
  aliases
) {
  return {
    id,
    canonicalName,
    category,
    nutritionPer100,
    defaultServing,
    aliases,
    source: "seed",
    updatedAt: INGREDIENT_CATALOG_SEED_UPDATED_AT,
  };
}

const CORE_INGREDIENT_CATALOG_SEED_ITEMS = [
  item("chicken_breast", "chicken breast", "protein", { calories: 165, protein: 31, carbs: 0, fat: 4, unit: "g" }, { quantity: 150, unit: "g" }, { en: ["chicken", "chicken breast", "grilled chicken"], "pt-PT": ["frango", "peito de frango", "frango grelhado"], "pt-BR": ["frango", "peito de frango", "frango grelhado"], es: ["pollo", "pechuga de pollo", "pollo a la plancha"], fr: ["poulet", "blanc de poulet", "poulet grille"], de: ["huhnchen", "hahnchenbrust", "gegrilltes hahnchen"] }),
  item("salmon", "salmon", "protein", { calories: 208, protein: 20, carbs: 0, fat: 13, unit: "g" }, { quantity: 150, unit: "g" }, { en: ["salmon", "grilled salmon", "salmon fillet"], "pt-PT": ["salmao", "salmao grelhado", "filete de salmao"], "pt-BR": ["salmao", "salmao grelhado", "file de salmao"], es: ["salmon", "salmon a la plancha", "filete de salmon"], fr: ["saumon", "saumon grille", "filet de saumon"], de: ["lachs", "gegrillter lachs", "lachsfilet"] }),
  item("tuna", "tuna", "protein", { calories: 132, protein: 29, carbs: 0, fat: 1, unit: "g" }, { quantity: 120, unit: "g" }, { en: ["tuna", "tuna fish", "canned tuna"], "pt-PT": ["atum", "atum enlatado"], "pt-BR": ["atum", "atum enlatado"], es: ["atun", "atun enlatado"], fr: ["thon", "thon en conserve"], de: ["thunfisch", "thunfisch aus der dose"] }),
  item("egg", "egg", "protein", { calories: 143, protein: 13, carbs: 1, fat: 10, unit: "g" }, { quantity: 50, unit: "g" }, { en: ["egg", "eggs"], "pt-PT": ["ovo", "ovos"], "pt-BR": ["ovo", "ovos"], es: ["huevo", "huevos"], fr: ["oeuf", "oeufs"], de: ["ei", "eier"] }),
  item("tofu", "tofu", "protein", { calories: 76, protein: 8, carbs: 2, fat: 5, unit: "g" }, { quantity: 120, unit: "g" }, { en: ["tofu"], "pt-PT": ["tofu"], "pt-BR": ["tofu"], es: ["tofu"], fr: ["tofu"], de: ["tofu"] }),
  item("beef", "beef", "protein", { calories: 250, protein: 26, carbs: 0, fat: 17, unit: "g" }, { quantity: 150, unit: "g" }, { en: ["beef", "beef strips", "steak"], "pt-PT": ["vaca", "carne de vaca", "bife"], "pt-BR": ["carne bovina", "bife", "carne"], es: ["ternera", "carne de res", "filete"], fr: ["boeuf", "steak"], de: ["rindfleisch", "steak"] }),
  item("rice", "rice", "carb", { calories: 130, protein: 3, carbs: 28, fat: 0.3, unit: "g" }, { quantity: 150, unit: "g" }, { en: ["rice", "white rice", "cooked rice"], "pt-PT": ["arroz", "arroz branco"], "pt-BR": ["arroz", "arroz branco"], es: ["arroz", "arroz blanco"], fr: ["riz", "riz blanc"], de: ["reis", "weisser reis"] }),
  item("pasta", "pasta", "carb", { calories: 157, protein: 6, carbs: 31, fat: 1, unit: "g" }, { quantity: 180, unit: "g" }, { en: ["pasta", "spaghetti", "noodles"], "pt-PT": ["massa", "esparguete"], "pt-BR": ["macarrao", "massa", "espaguete"], es: ["pasta", "espaguetis"], fr: ["pates", "spaghetti"], de: ["nudeln", "spaghetti", "pasta"] }),
  item("bread", "bread", "carb", { calories: 265, protein: 9, carbs: 49, fat: 3, unit: "g" }, { quantity: 30, unit: "g" }, { en: ["bread", "toast", "slice of bread"], "pt-PT": ["pao", "tosta", "fatia de pao"], "pt-BR": ["pao", "torrada", "fatia de pao"], es: ["pan", "tostada", "rebanada de pan"], fr: ["pain", "toast"], de: ["brot", "toast", "scheibe brot"] }),
  item("potato", "potato", "carb", { calories: 87, protein: 2, carbs: 20, fat: 0.1, unit: "g" }, { quantity: 180, unit: "g" }, { en: ["potato", "potatoes", "boiled potato"], "pt-PT": ["batata", "batatas"], "pt-BR": ["batata", "batatas"], es: ["patata", "patatas", "papa"], fr: ["pomme de terre", "pommes de terre"], de: ["kartoffel", "kartoffeln"] }),
  item("sweet_potato", "sweet potato", "carb", { calories: 86, protein: 2, carbs: 20, fat: 0.1, unit: "g" }, { quantity: 180, unit: "g" }, { en: ["sweet potato", "sweet potatoes"], "pt-PT": ["batata doce"], "pt-BR": ["batata doce"], es: ["batata dulce", "camote"], fr: ["patate douce"], de: ["susskartoffel"] }),
  item("oats", "oats", "carb", { calories: 389, protein: 17, carbs: 66, fat: 7, unit: "g" }, { quantity: 40, unit: "g" }, { en: ["oats", "oatmeal"], "pt-PT": ["aveia"], "pt-BR": ["aveia"], es: ["avena"], fr: ["avoine"], de: ["hafer"] }),
  item("tortilla", "tortilla", "carb", { calories: 310, protein: 8, carbs: 52, fat: 7, unit: "g" }, { quantity: 60, unit: "g" }, { en: ["tortilla", "wrap", "wrap tortilla"], "pt-PT": ["tortilha", "wrap"], "pt-BR": ["tortilha", "wrap"], es: ["tortilla", "wrap"], fr: ["tortilla", "wrap"], de: ["tortilla", "wrap"] }),
  item("yogurt", "yogurt", "dairy", { calories: 61, protein: 3.5, carbs: 4.7, fat: 3.3, unit: "g" }, { quantity: 125, unit: "g" }, { en: ["yogurt", "plain yogurt"], "pt-PT": ["iogurte"], "pt-BR": ["iogurte"], es: ["yogur"], fr: ["yaourt"], de: ["joghurt"] }),
  item("low_fat_yogurt", "low-fat yogurt", "dairy", { calories: 45, protein: 4.3, carbs: 6, fat: 0.3, unit: "g" }, { quantity: 125, unit: "g" }, { en: ["low-fat yogurt", "skim yogurt", "light yogurt"], "pt-PT": ["iogurte magro", "iogurte natural magro"], "pt-BR": ["iogurte desnatado", "iogurte light"], es: ["yogur desnatado", "yogur bajo en grasa"], fr: ["yaourt maigre", "yaourt allege"], de: ["magerjoghurt", "fettarmer joghurt"] }),
  item("greek_yogurt", "greek yogurt", "dairy", { calories: 97, protein: 9, carbs: 4, fat: 5, unit: "g" }, { quantity: 150, unit: "g" }, { en: ["greek yogurt"], "pt-PT": ["iogurte grego"], "pt-BR": ["iogurte grego"], es: ["yogur griego"], fr: ["yaourt grec"], de: ["griechischer joghurt"] }),
  item("milk", "milk", "dairy", { calories: 60, protein: 3.2, carbs: 4.8, fat: 3.3, unit: "ml" }, { quantity: 200, unit: "ml" }, { en: ["milk"], "pt-PT": ["leite"], "pt-BR": ["leite"], es: ["leche"], fr: ["lait"], de: ["milch"] }),
  item("cheese", "cheese", "dairy", { calories: 402, protein: 25, carbs: 1.3, fat: 33, unit: "g" }, { quantity: 30, unit: "g" }, { en: ["cheese"], "pt-PT": ["queijo"], "pt-BR": ["queijo"], es: ["queso"], fr: ["fromage"], de: ["kase"] }),
  item("butter", "butter", "dairy", { calories: 717, protein: 0.9, carbs: 0.1, fat: 81, unit: "g" }, { quantity: 10, unit: "g" }, { en: ["butter"], "pt-PT": ["manteiga"], "pt-BR": ["manteiga"], es: ["mantequilla"], fr: ["beurre"], de: ["butter"] }),
  item("banana", "banana", "fruit", { calories: 89, protein: 1.1, carbs: 23, fat: 0.3, unit: "g" }, { quantity: 120, unit: "g" }, { en: ["banana"], "pt-PT": ["banana"], "pt-BR": ["banana"], es: ["banana", "platano"], fr: ["banane"], de: ["banane"] }),
  item("apple", "apple", "fruit", { calories: 52, protein: 0.3, carbs: 14, fat: 0.2, unit: "g" }, { quantity: 150, unit: "g" }, { en: ["apple"], "pt-PT": ["maca"], "pt-BR": ["maca"], es: ["manzana"], fr: ["pomme"], de: ["apfel"] }),
  item("orange", "orange", "fruit", { calories: 47, protein: 0.9, carbs: 12, fat: 0.1, unit: "g" }, { quantity: 150, unit: "g" }, { en: ["orange"], "pt-PT": ["laranja"], "pt-BR": ["laranja"], es: ["naranja"], fr: ["orange"], de: ["orange"] }),
  item("berries", "berries", "fruit", { calories: 57, protein: 0.7, carbs: 14, fat: 0.3, unit: "g" }, { quantity: 80, unit: "g" }, { en: ["berries", "mixed berries"], "pt-PT": ["frutos vermelhos", "bagas"], "pt-BR": ["frutas vermelhas"], es: ["frutos rojos", "bayas"], fr: ["fruits rouges", "baies"], de: ["beeren", "beerenmix"] }),
  item("strawberries", "strawberries", "fruit", { calories: 32, protein: 0.7, carbs: 7.7, fat: 0.3, unit: "g" }, { quantity: 100, unit: "g" }, { en: ["strawberries", "strawberry"], "pt-PT": ["morangos", "morango"], "pt-BR": ["morangos", "morango"], es: ["fresas", "fresa"], fr: ["fraises", "fraise"], de: ["erdbeeren", "erdbeere"] }),
  item("blueberries", "blueberries", "fruit", { calories: 57, protein: 0.7, carbs: 14, fat: 0.3, unit: "g" }, { quantity: 80, unit: "g" }, { en: ["blueberries", "blueberry"], "pt-PT": ["mirtilos", "mirtilo"], "pt-BR": ["mirtilos", "mirtilo"], es: ["arandanos"], fr: ["myrtilles"], de: ["heidelbeeren", "heidelbeere"] }),
  item("avocado", "avocado", "fruit", { calories: 160, protein: 2, carbs: 9, fat: 15, unit: "g" }, { quantity: 100, unit: "g" }, { en: ["avocado"], "pt-PT": ["abacate"], "pt-BR": ["abacate"], es: ["aguacate"], fr: ["avocat"], de: ["avocado"] }),
  item("lettuce", "lettuce", "vegetable", { calories: 15, protein: 1.4, carbs: 2.9, fat: 0.2, unit: "g" }, { quantity: 50, unit: "g" }, { en: ["lettuce"], "pt-PT": ["alface"], "pt-BR": ["alface"], es: ["lechuga"], fr: ["laitue"], de: ["salat", "kopfsalat"] }),
  item("tomato", "tomato", "vegetable", { calories: 18, protein: 0.9, carbs: 3.9, fat: 0.2, unit: "g" }, { quantity: 120, unit: "g" }, { en: ["tomato", "tomatoes"], "pt-PT": ["tomate", "tomates"], "pt-BR": ["tomate", "tomates"], es: ["tomate", "tomates"], fr: ["tomate", "tomates"], de: ["tomate", "tomaten"] }),
  item("onion", "onion", "vegetable", { calories: 40, protein: 1.1, carbs: 9.3, fat: 0.1, unit: "g" }, { quantity: 80, unit: "g" }, { en: ["onion"], "pt-PT": ["cebola"], "pt-BR": ["cebola"], es: ["cebolla"], fr: ["oignon"], de: ["zwiebel"] }),
  item("broccoli", "broccoli", "vegetable", { calories: 34, protein: 2.8, carbs: 7, fat: 0.4, unit: "g" }, { quantity: 90, unit: "g" }, { en: ["broccoli"], "pt-PT": ["brocolos", "brocolo"], "pt-BR": ["brocolis", "brocolis cozido"], es: ["brocoli"], fr: ["brocoli"], de: ["brokkoli"] }),
  item("carrot", "carrot", "vegetable", { calories: 41, protein: 0.9, carbs: 10, fat: 0.2, unit: "g" }, { quantity: 80, unit: "g" }, { en: ["carrot", "carrots"], "pt-PT": ["cenoura", "cenouras"], "pt-BR": ["cenoura", "cenouras"], es: ["zanahoria", "zanahorias"], fr: ["carotte", "carottes"], de: ["karotte", "karotten"] }),
  item("cucumber", "cucumber", "vegetable", { calories: 15, protein: 0.7, carbs: 3.6, fat: 0.1, unit: "g" }, { quantity: 100, unit: "g" }, { en: ["cucumber"], "pt-PT": ["pepino"], "pt-BR": ["pepino"], es: ["pepino"], fr: ["concombre"], de: ["gurke"] }),
  item("spinach", "spinach", "vegetable", { calories: 23, protein: 2.9, carbs: 3.6, fat: 0.4, unit: "g" }, { quantity: 60, unit: "g" }, { en: ["spinach"], "pt-PT": ["espinafres"], "pt-BR": ["espinafre"], es: ["espinaca"], fr: ["epinards"], de: ["spinat"] }),
  item("bell_pepper", "bell pepper", "vegetable", { calories: 31, protein: 1, carbs: 6, fat: 0.3, unit: "g" }, { quantity: 100, unit: "g" }, { en: ["bell pepper", "pepper"], "pt-PT": ["pimento"], "pt-BR": ["pimentao"], es: ["pimiento"], fr: ["poivron"], de: ["paprika"] }),
  item("mushroom", "mushroom", "vegetable", { calories: 22, protein: 3.1, carbs: 3.3, fat: 0.3, unit: "g" }, { quantity: 80, unit: "g" }, { en: ["mushroom", "mushrooms"], "pt-PT": ["cogumelo", "cogumelos"], "pt-BR": ["cogumelo", "cogumelos"], es: ["champinon", "setas"], fr: ["champignon", "champignons"], de: ["pilz", "pilze"] }),
  item("corn", "corn", "vegetable", { calories: 96, protein: 3.4, carbs: 21, fat: 1.5, unit: "g" }, { quantity: 80, unit: "g" }, { en: ["corn"], "pt-PT": ["milho"], "pt-BR": ["milho"], es: ["maiz"], fr: ["mais"], de: ["mais"] }),
  item("beans", "beans", "legume", { calories: 127, protein: 9, carbs: 23, fat: 0.5, unit: "g" }, { quantity: 130, unit: "g" }, { en: ["beans", "black beans", "kidney beans"], "pt-PT": ["feijao", "feijao preto"], "pt-BR": ["feijao", "feijao preto"], es: ["frijoles", "alubias"], fr: ["haricots", "haricots noirs"], de: ["bohnen", "schwarze bohnen"] }),
  item("chickpeas", "chickpeas", "legume", { calories: 164, protein: 9, carbs: 27, fat: 2.6, unit: "g" }, { quantity: 120, unit: "g" }, { en: ["chickpeas"], "pt-PT": ["grao de bico"], "pt-BR": ["grao de bico"], es: ["garbanzos"], fr: ["pois chiches"], de: ["kichererbsen"] }),
  item("olive_oil", "olive oil", "fat", { calories: 884, protein: 0, carbs: 0, fat: 100, unit: "g" }, { quantity: 14, unit: "g" }, { en: ["olive oil"], "pt-PT": ["azeite"], "pt-BR": ["azeite de oliva", "azeite"], es: ["aceite de oliva"], fr: ["huile d olive"], de: ["olivenol"] }),
  item("peanut_butter", "peanut butter", "fat", { calories: 588, protein: 25, carbs: 20, fat: 50, unit: "g" }, { quantity: 16, unit: "g" }, { en: ["peanut butter"], "pt-PT": ["manteiga de amendoim"], "pt-BR": ["pasta de amendoim"], es: ["mantequilla de cacahuete"], fr: ["beurre de cacahuete"], de: ["erdnussbutter"] }),
  item("granola", "granola", "breakfast", { calories: 471, protein: 10, carbs: 64, fat: 19, unit: "g" }, { quantity: 40, unit: "g" }, { en: ["granola"], "pt-PT": ["granola"], "pt-BR": ["granola"], es: ["granola"], fr: ["granola"], de: ["granola"] }),
  item("honey", "honey", "sweetener", { calories: 304, protein: 0.3, carbs: 82, fat: 0, unit: "g" }, { quantity: 21, unit: "g" }, { en: ["honey"], "pt-PT": ["mel"], "pt-BR": ["mel"], es: ["miel"], fr: ["miel"], de: ["honig"] }),
  item("coffee", "coffee", "drink", { calories: 1, protein: 0.1, carbs: 0, fat: 0, unit: "ml" }, { quantity: 200, unit: "ml" }, { en: ["coffee", "black coffee"], "pt-PT": ["cafe"], "pt-BR": ["cafe"], es: ["cafe"], fr: ["cafe"], de: ["kaffee"] }),
  item("tea", "tea", "drink", { calories: 1, protein: 0, carbs: 0, fat: 0, unit: "ml" }, { quantity: 200, unit: "ml" }, { en: ["tea"], "pt-PT": ["cha"], "pt-BR": ["cha"], es: ["te"], fr: ["the"], de: ["tee"] }),
  item("orange_juice", "orange juice", "drink", { calories: 45, protein: 0.7, carbs: 10, fat: 0.2, unit: "ml" }, { quantity: 200, unit: "ml" }, { en: ["orange juice", "juice"], "pt-PT": ["sumo de laranja", "sumo"], "pt-BR": ["suco de laranja", "suco"], es: ["zumo de naranja", "jugo de naranja"], fr: ["jus d orange"], de: ["orangensaft"] }),
  item("apple_juice", "apple juice", "drink", { calories: 46, protein: 0.1, carbs: 11, fat: 0.1, unit: "ml" }, { quantity: 200, unit: "ml" }, { en: ["apple juice"], "pt-PT": ["sumo de maca"], "pt-BR": ["suco de maca"], es: ["zumo de manzana"], fr: ["jus de pomme"], de: ["apfelsaft"] }),
  item("cola", "cola", "drink", { calories: 42, protein: 0, carbs: 10.6, fat: 0, unit: "ml" }, { quantity: 330, unit: "ml" }, { en: ["cola", "coke", "soft drink"], "pt-PT": ["cola", "coca cola", "refrigerante"], "pt-BR": ["cola", "coca cola", "refrigerante"], es: ["cola", "refresco"], fr: ["cola", "soda"], de: ["cola", "limonade"] }),
  item("water", "water", "drink", { calories: 0, protein: 0, carbs: 0, fat: 0, unit: "ml" }, { quantity: 250, unit: "ml" }, { en: ["water"], "pt-PT": ["agua"], "pt-BR": ["agua"], es: ["agua"], fr: ["eau"], de: ["wasser"] }),
  item("tomato_sauce", "tomato sauce", "sauce", { calories: 29, protein: 1.4, carbs: 6, fat: 0.2, unit: "g" }, { quantity: 125, unit: "g" }, { en: ["tomato sauce", "pasta sauce"], "pt-PT": ["molho de tomate"], "pt-BR": ["molho de tomate"], es: ["salsa de tomate"], fr: ["sauce tomate"], de: ["tomatensosse"] }),
  item("soup", "soup", "prepared", { calories: 45, protein: 2, carbs: 6, fat: 1.5, unit: "ml" }, { quantity: 300, unit: "ml" }, { en: ["soup", "vegetable soup"], "pt-PT": ["sopa"], "pt-BR": ["sopa"], es: ["sopa"], fr: ["soupe"], de: ["suppe"] }),
  item("burger", "burger", "prepared", { calories: 250, protein: 13, carbs: 22, fat: 12, unit: "g" }, { quantity: 150, unit: "g" }, { en: ["burger", "hamburger"], "pt-PT": ["hamburguer"], "pt-BR": ["hamburguer"], es: ["hamburguesa"], fr: ["burger", "hamburger"], de: ["burger", "hamburger"] }),
  item("breaded_chicken", "breaded chicken", "prepared", { calories: 260, protein: 20, carbs: 14, fat: 14, unit: "g" }, { quantity: 150, unit: "g" }, { en: ["breaded chicken", "chicken schnitzel"], "pt-PT": ["frango panado"], "pt-BR": ["frango empanado"], es: ["pollo empanado"], fr: ["poulet pane"], de: ["paniertes huhn", "hahnchenschnitzel"] }),
  item("fries", "fries", "prepared", { calories: 312, protein: 3.4, carbs: 41, fat: 15, unit: "g" }, { quantity: 120, unit: "g" }, { en: ["fries", "french fries"], "pt-PT": ["batatas fritas"], "pt-BR": ["batata frita", "batatas fritas"], es: ["patatas fritas"], fr: ["frites"], de: ["pommes", "pommes frites"] }),
];

export const INGREDIENT_CATALOG_SEED_ITEMS = [
  ...CORE_INGREDIENT_CATALOG_SEED_ITEMS,
  ...INGREDIENT_CATALOG_EXPANDED_SEED_ITEMS,
];

export const INGREDIENT_CATALOG_SEED_MANIFEST = {
  version: String(Math.max(INGREDIENT_CATALOG_SEED_UPDATED_AT, INGREDIENT_CATALOG_EXPANDED_SEED_UPDATED_AT)),
  updatedAt: Math.max(INGREDIENT_CATALOG_SEED_UPDATED_AT, INGREDIENT_CATALOG_EXPANDED_SEED_UPDATED_AT),
  locales: ["en", "pt-PT", "pt-BR", "es", "fr", "de"],
  itemCount: INGREDIENT_CATALOG_SEED_ITEMS.length,
};
