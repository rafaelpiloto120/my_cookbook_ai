import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";

import { auth } from "../firebaseConfig";
import { getApiBaseUrl } from "../lib/config/api";
import { fetchEconomyCatalogBundle } from "../lib/economy/client";
import { addClaimableRewardsChangedListener } from "../lib/economy/claimableRewardsEvents";
import EggIcon from "./EggIcon";

const isRewardClaimable = (reward?: { status?: string; progress?: number | null; target?: number | null } | null) => {
  if (reward?.status !== "available") return false;
  const rewardKey = "rewardKey" in (reward || {}) ? String((reward as any).rewardKey || "") : "";
  const id = "id" in (reward || {}) ? String((reward as any).id || "") : "";
  if (rewardKey === "signup_bonus_v1" || id === "signup_bonus_v1") return false;
  if (typeof reward.target !== "number" || !Number.isFinite(reward.target)) return true;
  if (typeof reward.progress !== "number" || !Number.isFinite(reward.progress)) return false;
  return reward.progress >= Math.max(1, Math.floor(reward.target));
};

export default function EconomyHeaderAlertButton() {
  const router = useRouter();
  const [hasClaimableReward, setHasClaimableReward] = useState(false);
  const mountedRef = useRef(true);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);

  const refreshClaimableRewards = useCallback(async () => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    refreshQueuedRef.current = false;
    try {
      const backendUrl = getApiBaseUrl();
      if (!backendUrl) {
        if (mountedRef.current) setHasClaimableReward(false);
        return;
      }

      const catalog = await fetchEconomyCatalogBundle({
        backendUrl,
        appEnv: process.env.EXPO_PUBLIC_APP_ENV ?? "local",
        auth,
      });
      const economyVisible = catalog.showEconomy === true || catalog.missions?.unlocked === true;
      const hasMissionReward = Array.isArray(catalog.missions?.rewards)
        ? catalog.missions.rewards.some((reward) => isRewardClaimable(reward))
        : false;
      const hasMilestoneReward = Array.isArray(catalog.bonuses)
        ? catalog.bonuses.some((bonus) => isRewardClaimable(bonus))
        : false;

      if (mountedRef.current) {
        setHasClaimableReward(economyVisible && (hasMissionReward || hasMilestoneReward));
      }
    } catch {
      if (mountedRef.current) setHasClaimableReward(false);
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current && mountedRef.current) {
        refreshQueuedRef.current = false;
        setTimeout(() => {
          void refreshClaimableRewards();
        }, 250);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshClaimableRewards();

    const economySub = addClaimableRewardsChangedListener(() => {
      void refreshClaimableRewards();
    });
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void refreshClaimableRewards();
      }
    });
    const interval = setInterval(() => {
      void refreshClaimableRewards();
    }, 45000);

    return () => {
      mountedRef.current = false;
      economySub.remove();
      appStateSub.remove();
      clearInterval(interval);
    };
  }, [refreshClaimableRewards]);

  useFocusEffect(
    useCallback(() => {
      void refreshClaimableRewards();
      return undefined;
    }, [refreshClaimableRewards])
  );

  if (!hasClaimableReward) return null;

  return (
    <TouchableOpacity
      activeOpacity={0.8}
      hitSlop={10}
      style={styles.button}
      onPress={() => {
        router.push({ pathname: "/(tabs)/economy/store", params: { focusClaim: String(Date.now()) } } as any);
      }}
    >
      <EggIcon size={25} />
      <View style={styles.dot} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 4,
  },
  dot: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 9,
    height: 9,
    borderRadius: 999,
    backgroundColor: "#D92D20",
    borderWidth: 1.5,
    borderColor: "#FFFFFF",
  },
});
