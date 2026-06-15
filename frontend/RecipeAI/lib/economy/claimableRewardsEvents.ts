import { DeviceEventEmitter } from "react-native";

const ECONOMY_CLAIMABLE_REWARDS_CHANGED = "economy:claimable-rewards-changed";

export function emitClaimableRewardsChanged() {
  DeviceEventEmitter.emit(ECONOMY_CLAIMABLE_REWARDS_CHANGED);
}

export function addClaimableRewardsChangedListener(listener: () => void) {
  return DeviceEventEmitter.addListener(ECONOMY_CLAIMABLE_REWARDS_CHANGED, listener);
}
