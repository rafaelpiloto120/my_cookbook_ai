import React from "react";
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import EggIcon from "./EggIcon";
import type { EconomyCatalogOffer } from "../lib/economy/client";

type Props = {
  visible: boolean;
  isDark: boolean;
  title: string;
  body: string;
  featuredOffer?: EconomyCatalogOffer | null;
  availableRewardsCount?: number;
  onClose: () => void;
  onOpenStore: () => void;
  onBuyOffer?: () => void;
  onOpenRewards?: () => void;
};

export default function InsufficientCookiesModal({
  visible,
  isDark,
  title,
  body,
  featuredOffer,
  availableRewardsCount = 0,
  onClose,
  onOpenStore,
  onBuyOffer,
  onOpenRewards,
}: Props) {
  const hasRewards = availableRewardsCount > 0 && typeof onOpenRewards === "function";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={styles.modalCenter}>
        <View
          style={[
            styles.modalCard,
            {
              backgroundColor: isDark ? "#1f2430" : "#fff",
              borderColor: isDark ? "#ffffff22" : "#00000012",
            },
          ]}
        >
          <TouchableOpacity
            onPress={onClose}
            style={styles.modalCloseBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={[styles.modalCloseText, { color: isDark ? "#f5f5f5" : "#293a53" }]}>✕</Text>
          </TouchableOpacity>

          <Text style={[styles.modalTitle, { color: isDark ? "#f5f5f5" : "#293a53" }]}>{title}</Text>
          <Text style={[styles.modalBody, { color: isDark ? "#ddd" : "#444" }]}>{body}</Text>

          {featuredOffer ? (
            <TouchableOpacity
              activeOpacity={0.85}
              style={[
                styles.offerCard,
                {
                  backgroundColor: isDark ? "#171b24" : "#fff",
                  borderColor: isDark ? "#ffffff22" : "#00000012",
                },
              ]}
              onPress={onBuyOffer || onOpenStore}
            >
              <View style={{ flex: 1 }}>
                <View style={styles.offerTitleRow}>
                  <EggIcon size={24} />
                  <Text style={[styles.offerTitle, { color: isDark ? "#f5f5f5" : "#293a53" }]}>
                    {featuredOffer.cookies} Eggs
                  </Text>
                </View>
                <Text style={[styles.offerSubtitle, { color: isDark ? "#ddd" : "#666" }]}>
                  {featuredOffer.subtitle
                    ? `${featuredOffer.subtitle} | ${featuredOffer.price.toFixed(2)} ${String(
                        featuredOffer.currency || "USD"
                      ).toUpperCase()}`
                    : `${featuredOffer.price.toFixed(2)} ${String(
                        featuredOffer.currency || "USD"
                      ).toUpperCase()}`}
                </Text>
                {featuredOffer.badges?.length ? (
                  <View style={styles.badgeRow}>
                    {featuredOffer.badges.map((badge) => (
                      <View
                        key={badge}
                        style={[
                          styles.badgeChip,
                          { backgroundColor: isDark ? "#ffffff14" : "#0000000d" },
                        ]}
                      >
                        <Text style={[styles.badgeText, { color: isDark ? "#f5f5f5" : "#293a53" }]}>
                          {badge}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
              <View style={styles.offerRight}>
                <Text style={styles.offerCta}>Buy</Text>
              </View>
            </TouchableOpacity>
          ) : null}

          {hasRewards ? (
            <Text style={[styles.rewardsText, styles.rewardsRow, { color: isDark ? "#ddd" : "#555" }]}>
              {availableRewardsCount === 1
                ? "You still have 1 way to earn free Eggs."
                : `You still have ${availableRewardsCount} ways to earn free Eggs.`}
              {" "}
              <Text style={styles.rewardsLink} onPress={onOpenRewards}>
                See rewards
              </Text>
            </Text>
          ) : null}

          <View style={styles.actions}>
            <TouchableOpacity activeOpacity={0.85} style={styles.secondaryButton} onPress={onClose}>
              <Text style={styles.secondaryButtonText}>Not now</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.85} style={styles.primaryButton} onPress={onOpenStore}>
              <Text style={styles.primaryButtonText}>All plans</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  modalCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 22,
    borderWidth: 1,
    padding: 18,
    paddingTop: 16,
  },
  modalCloseBtn: {
    position: "absolute",
    top: 14,
    right: 14,
    zIndex: 2,
  },
  modalCloseText: {
    fontSize: 18,
    fontWeight: "700",
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: "800",
    paddingRight: 28,
    marginTop: 2,
    marginBottom: 10,
  },
  modalBody: {
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 16,
  },
  offerCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 14,
  },
  offerTitle: {
    fontSize: 18,
    fontWeight: "900",
  },
  offerTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  offerSubtitle: {
    fontSize: 14,
    marginTop: 6,
  },
  offerRight: {
    marginLeft: 14,
  },
  offerCta: {
    color: "#E27D60",
    fontWeight: "800",
    fontSize: 14,
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 10,
  },
  badgeChip: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "800",
  },
  rewardsRow: {
    marginBottom: 16,
  },
  rewardsText: {
    fontSize: 13,
    lineHeight: 18,
  },
  rewardsLink: {
    color: "#E27D60",
    fontSize: 13,
    fontWeight: "800",
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },
  secondaryButton: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d6d6d6",
    paddingHorizontal: 16,
    paddingVertical: 11,
    backgroundColor: "#fff",
  },
  secondaryButtonText: {
    color: "#293a53",
    fontWeight: "700",
  },
  primaryButton: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
    backgroundColor: "#E27D60",
  },
  primaryButtonText: {
    color: "#fff",
    fontWeight: "800",
  },
});
