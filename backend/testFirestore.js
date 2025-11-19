import admin from "firebase-admin";
import { readFileSync } from "fs";

const serviceAccount = JSON.parse(
  readFileSync(new URL("./recipeai-service-account.json", import.meta.url))
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://recipeai-frontend.firebaseio.com",
});

const db = admin.firestore();

const test = async () => {
  const doc = await db.collection("users").doc("testuser").get();
  console.log(doc.exists ? "✅ Firestore reachable" : "❌ Missing doc");
};

test().catch(console.error);