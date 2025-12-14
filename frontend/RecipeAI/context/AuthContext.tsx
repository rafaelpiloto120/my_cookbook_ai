import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  onAuthStateChanged,
  signOut,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithCredential,
  signInAnonymously,
  EmailAuthProvider,
  linkWithCredential,
  User,
} from "firebase/auth";
import { auth } from "../firebaseConfig";
import { syncEngine } from "../lib/sync/SyncEngine";

type AuthContextValue = {
  user: User | null;
  setUser: (u: User | null) => void;
  signup: (email: string, password: string) => Promise<User>;
  login: (email: string, password: string) => Promise<User>;
  loginWithGoogle: (idToken: string) => Promise<User>;
  logout: () => Promise<void>;
  loading: boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const hasTriedAnonRef = useRef(false);
  const lastUidRef = useRef<string | null>(null);
  const postAuthSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedulePostAuthSync = useCallback((uid: string) => {
    // Avoid re-scheduling for the same uid (can happen with repeated auth events)
    if (lastUidRef.current === uid) return;
    lastUidRef.current = uid;

    if (postAuthSyncTimerRef.current) {
      clearTimeout(postAuthSyncTimerRef.current);
      postAuthSyncTimerRef.current = null;
    }

    // We often have a "tab-focus" sync that runs right as the app mounts.
    // SyncEngine may throttle auth-change-triggered syncs if they happen too soon after.
    // So:
    //  - try an immediate "forced" sync if supported
    //  - otherwise schedule a sync slightly after the throttle window (8s)
    const se: any = syncEngine;

    postAuthSyncTimerRef.current = setTimeout(async () => {
      try {
        if (typeof se?.syncAll === "function") {
          // Try common call shapes (keep them guarded to avoid breaking if the signature differs)
          try {
            await se.syncAll({ reason: "auth-ready", scope: "all", force: true });
            return;
          } catch {}

          try {
            await se.syncAll("auth-ready", "all", true);
            return;
          } catch {}

          try {
            await se.syncAll("auth-ready");
            return;
          } catch {}
        }

        // If SyncEngine has a different API, at least attempt to call a generic method.
        if (typeof se?.sync === "function") {
          try {
            await se.sync({ reason: "auth-ready", scope: "all" });
            return;
          } catch {}
        }

        console.log("[AuthContext] Post-auth sync skipped: SyncEngine has no compatible sync method");
      } catch (err) {
        console.warn("[AuthContext] Post-auth sync failed", err);
      }
    }, 8200);
  }, []);

  const safeStopSyncEngine = useCallback(async (reason: string) => {
    const se: any = syncEngine;
    try {
      if (typeof se?.stop === "function") {
        await se.stop(reason);
        return;
      }
    } catch (e) {
      console.warn("[AuthContext] SyncEngine.stop failed", e);
    }

    // Fallback: at least notify auth change so modules can unsubscribe
    try {
      if (typeof se?.handleAuthStateChanged === "function") {
        await se.handleAuthStateChanged(null);
      }
    } catch (e) {
      console.warn("[AuthContext] SyncEngine.handleAuthStateChanged(null) failed", e);
    }
  }, []);

  const safeClearFirestoreCache = useCallback(async () => {
    const se: any = syncEngine;
    try {
      if (typeof se?.clearFirestoreCache === "function") {
        await se.clearFirestoreCache();
      }
    } catch (e) {
      // This is best-effort; environments without persistence support may throw.
      console.warn("[AuthContext] clearFirestoreCache skipped/failed", e);
    }
  }, []);

  useEffect(() => {
    console.log("[AuthContext] mounting AuthProvider");

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      console.log("[AuthContext] onAuthStateChanged fired", {
        email: firebaseUser?.email ?? null,
        uid: firebaseUser?.uid ?? null,
        isAnonymous: firebaseUser?.isAnonymous ?? null,
      });

      // If there's no user yet, attempt a one-time anonymous sign-in
      if (!firebaseUser && !hasTriedAnonRef.current) {
        hasTriedAnonRef.current = true;
        try {
          console.log("[AuthContext] No user; signing in anonymously…");
          const result = await signInAnonymously(auth);
          console.log("[AuthContext] Anonymous sign-in success", {
            uid: result.user.uid,
            isAnonymous: result.user.isAnonymous,
          });
          // onAuthStateChanged will fire again with the anonymous user
        } catch (err) {
          console.warn("[AuthContext] Anonymous sign-in failed", err);
          setLoading(false);
        }
        return;
      }

      setUser(firebaseUser ?? null);
      setLoading(false);

      // Notify sync engine about auth state changes (including UID + anonymous flag)
      syncEngine
        .handleAuthStateChanged(
          firebaseUser
            ? { uid: firebaseUser.uid, isAnonymous: firebaseUser.isAnonymous ?? false }
            : null
        )
        .catch((err: unknown) => {
          console.warn("[SyncEngine] handleAuthStateChanged error", err);
        });

      if (!firebaseUser) {
        console.log("[AuthContext] No user; skipping extra auth side effects");
        return;
      }

      // Ensure an initial sync happens after auth is ready (especially for anonymous flows)
      // so onboarding-created cookbooks/preferences get pushed even if the first sync was throttled.
      schedulePostAuthSync(firebaseUser.uid);
    });

    return () => {
      console.log("[AuthContext] unmounting AuthProvider");
      if (postAuthSyncTimerRef.current) {
        clearTimeout(postAuthSyncTimerRef.current);
        postAuthSyncTimerRef.current = null;
      }
      unsubscribe();
    };
  }, [schedulePostAuthSync]);

  const signup = async (email: string, password: string) => {
    const current = auth.currentUser;

    // If current user is anonymous, link credentials instead of creating a new account
    if (current && current.isAnonymous) {
      console.log("[AuthContext] Linking anonymous user during signup");
      const credential = EmailAuthProvider.credential(email, password);
      try {
        const result = await linkWithCredential(current, credential);
        console.log("[AuthContext] linkWithCredential (signup) success", {
          uid: result.user.uid,
          email: result.user.email,
          isAnonymous: result.user.isAnonymous,
        });
        setUser(result.user);
        return result.user;
      } catch (error: any) {
        if (
          error?.code === "auth/credential-already-in-use" ||
          error?.code === "auth/email-already-in-use"
        ) {
          console.warn("[AuthContext] Email already in use during signup", error);
        } else {
          console.warn("[AuthContext] linkWithCredential (signup) failed", error);
        }
        throw error;
      }
    }

    const result = await createUserWithEmailAndPassword(auth, email, password);
    console.log("[AuthContext] createUserWithEmailAndPassword success", {
      uid: result.user.uid,
      email: result.user.email,
      isAnonymous: result.user.isAnonymous,
    });
    setUser(result.user);
    return result.user;
  };

  const login = async (email: string, password: string) => {
    const current = auth.currentUser;

    // If current user is anonymous, try to link credentials first
    if (current && current.isAnonymous) {
      console.log("[AuthContext] Linking anonymous user during login");
      const credential = EmailAuthProvider.credential(email, password);

      try {
        const result = await linkWithCredential(current, credential);
        console.log("[AuthContext] linkWithCredential (login) success", {
          uid: result.user.uid,
          email: result.user.email,
          isAnonymous: result.user.isAnonymous,
        });
        setUser(result.user);
        return result.user;
      } catch (error: any) {
        if (
          error?.code === "auth/credential-already-in-use" ||
          error?.code === "auth/email-already-in-use"
        ) {
          // The email/password already belongs to an existing account.
          // Fall back to a normal sign-in (data from the anonymous account will not be merged).
          console.log(
            "[AuthContext] credential/email already in use during login; signing in instead"
          );
          const signInResult = await signInWithEmailAndPassword(auth, email, password);
          console.log("[AuthContext] signInWithEmailAndPassword (fallback) success", {
            uid: signInResult.user.uid,
            email: signInResult.user.email,
            isAnonymous: signInResult.user.isAnonymous,
          });
          setUser(signInResult.user);
          return signInResult.user;
        }

        console.warn("[AuthContext] linkWithCredential (login) failed", error);
        throw error;
      }
    }

    const result = await signInWithEmailAndPassword(auth, email, password);
    console.log("[AuthContext] signInWithEmailAndPassword success", {
      uid: result.user.uid,
      email: result.user.email,
      isAnonymous: result.user.isAnonymous,
    });
    setUser(result.user);
    return result.user;
  };

  const loginWithGoogle = async (idToken: string) => {
    const googleCredential = GoogleAuthProvider.credential(idToken);
    const current = auth.currentUser;

    // If current user is anonymous, attempt to link Google credential
    if (current && current.isAnonymous) {
      console.log("[AuthContext] Linking anonymous user with Google credentials");
      try {
        const result = await linkWithCredential(current, googleCredential);
        console.log("[AuthContext] linkWithCredential (Google) success", {
          uid: result.user.uid,
          email: result.user.email,
          isAnonymous: result.user.isAnonymous,
        });
        setUser(result.user);
        return result.user;
      } catch (error: any) {
        if (error?.code === "auth/credential-already-in-use") {
          console.log(
            "[AuthContext] Google credential already in use; signing in instead"
          );
          const signInResult = await signInWithCredential(auth, googleCredential);
          console.log("[AuthContext] signInWithCredential (Google fallback) success", {
            uid: signInResult.user.uid,
            email: signInResult.user.email,
            isAnonymous: signInResult.user.isAnonymous,
          });
          setUser(signInResult.user);
          return signInResult.user;
        }

        console.warn("[AuthContext] Google linkWithCredential failed", error);
        throw error;
      }
    }

    const result = await signInWithCredential(auth, googleCredential);
    console.log("[AuthContext] signInWithCredential (Google) success", {
      uid: result.user.uid,
      email: result.user.email,
      isAnonymous: result.user.isAnonymous,
    });
    setUser(result.user);
    return result.user;
  };

  const logout = async () => {
    console.log("[AuthContext] logout initiated");

    // Stop any pending post-auth sync timer
    if (postAuthSyncTimerRef.current) {
      clearTimeout(postAuthSyncTimerRef.current);
      postAuthSyncTimerRef.current = null;
    }

    // Stop sync engine/listeners first to avoid repopulating state while we wipe local data
    await safeStopSyncEngine("logout");

    // Sign out current user
    try {
      await signOut(auth);
    } catch (err) {
      console.warn("[AuthContext] signOut failed", err);
    }

    // Reset local auth-side refs so we can re-enter anonymous mode cleanly
    lastUidRef.current = null;
    hasTriedAnonRef.current = false;

    // Clear all local app data (privacy-first). This also forces onboarding again.
    try {
      await AsyncStorage.clear();
      console.log("[AuthContext] AsyncStorage cleared");
    } catch (err) {
      console.warn("[AuthContext] AsyncStorage.clear failed", err);
    }

    // Best-effort: clear Firestore cache if your SyncEngine exposes a helper.
    // (Some environments don't support persistence clearing; safe to ignore failures.)
    await safeClearFirestoreCache();

    // Immediately create a fresh anonymous sandbox identity
    try {
      console.log("[AuthContext] signing in anonymously after logout…");
      const result = await signInAnonymously(auth);
      console.log("[AuthContext] post-logout anonymous sign-in success", {
        uid: result.user.uid,
        isAnonymous: result.user.isAnonymous,
      });
      // onAuthStateChanged will fire again and SyncEngine will be notified there.
    } catch (err) {
      console.warn("[AuthContext] post-logout anonymous sign-in failed", err);
      // Even if anonymous sign-in fails, user is logged out and local data is cleared.
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, setUser, signup, login, loginWithGoogle, logout, loading }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
};