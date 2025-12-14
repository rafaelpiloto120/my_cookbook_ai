// utils/testFirestore.ts
import { collection, getDocs, doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebaseConfig";

export async function testFirestoreRoundtrip(label: string) {
  try {
    console.log("[TestFirestore] starting roundtrip test", { label });

    // 1) Test a read from a dedicated test collection
    const readSnap = await getDocs(collection(db, "debugConnectionTest"));
    console.log("[TestFirestore] readSnap size:", readSnap.size);

    // 2) Test a write to a known document
    const ref = doc(db, "debugConnectionTest", "fromMobileApp");
    await setDoc(
      ref,
      {
        label,
        ts: serverTimestamp(),
        client: "mobile",
      },
      { merge: true }
    );

    console.log("[TestFirestore] ✅ write OK to debugConnectionTest/fromMobileApp");
  } catch (err) {
    console.warn("[TestFirestore] ❌ roundtrip error", err);
  }
}