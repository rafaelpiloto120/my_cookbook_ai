import type { Auth } from "firebase/auth";

import { claimEconomyReward } from "./client";

type RewardClaimParams = {
  backendUrl?: string | null;
  appEnv?: string;
  auth: Auth;
};

export function getRecipeRewardKeysForCount(count: number) {
  const keys: string[] = [];
  if (count >= 1) keys.push("first_recipe_saved_v1");
  if (count >= 10) keys.push("recipes_10_v1");
  if (count >= 25) keys.push("recipes_25_v1");
  return keys;
}

export function getMealRewardKeysForCount(count: number) {
  const keys: string[] = [];
  if (count >= 1) keys.push("first_meal_logged_v1");
  if (count >= 10) keys.push("meals_10_v1");
  if (count >= 25) keys.push("meals_25_v1");
  return keys;
}

export async function claimRewardKeysSequentially(
  { backendUrl, appEnv = "local", auth }: RewardClaimParams,
  rewardKeys: string[]
) {
  if (!backendUrl || !rewardKeys.length) return null;

  let lastResult: any = null;
  for (const rewardKey of rewardKeys) {
    lastResult = await claimEconomyReward({
      backendUrl,
      appEnv,
      auth,
      rewardKey,
    });
  }
  return lastResult;
}
