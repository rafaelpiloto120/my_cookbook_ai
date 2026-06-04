import React from "react";
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import EggIcon from "./EggIcon";
import type { EconomyCatalogOffer } from "../lib/economy/client";
import { useThemeColors } from "../context/ThemeContext";
import { useTranslation } from "react-i18next";
import { formatEconomyUnits } from "../lib/economy/format";

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
  const { t } = useTranslation();
  const hasRewards = availableRewardsCount > 0 && typeof onOpenRewards === "function";
  const {
    card,
    border,
    text,
    mutedText,
    sectionTitle,
    surfaceAlt,
    subtleBorder,
    softAccentBg,
    accentText,
    cta,
    onCta,
    bg,
  } = useThemeColors();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={styles.modalCenter}>
        <View
          style={[
            styles.modalCard,
            {
              backgroundColor: card,
              borderColor: border,
            },
          ]}
        >
          <TouchableOpacity
            onPress={onClose}
            style={styles.modalCloseBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={[styles.modalCloseText, { color: sectionTitle }]}>✕</Text>
          </TouchableOpacity>

          <Text style={[styles.modalTitle, { color: sectionTitle }]}>{title}</Text>
          <Text style={[styles.modalBody, { color: mutedText }]}>{body}</Text>

          {featuredOffer ? (
            <TouchableOpacity
              activeOpacity={0.85}
              style={[
                styles.offerCard,
                {
                  backgroundColor: surfaceAlt,
                  borderColor: subtleBorder,
                },
              ]}
              onPress={onBuyOffer || onOpenStore}
            >
              <View style={{ flex: 1 }}>
                <View style={styles.offerTitleRow}>
                  <EggIcon size={24} />
                  <Text style={[styles.offerTitle, { color: sectionTitle }]}>
                    {formatEconomyUnits(t, featuredOffer.cookies)}
                  </Text>
                </View>
                <Text style={[styles.offerSubtitle, { color: mutedText }]}>
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
                          { backgroundColor: softAccentBg },
                        ]}
                      >
                        <Text style={[styles.badgeText, { color: accentText }]}>
                          {badge}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
              <View style={styles.offerRight}>
                <Text style={[styles.offerCta, { color: accentText }]}>Buy</Text>
              </View>
            </TouchableOpacity>
          ) : null}

          {hasRewards ? (
            <Text style={[styles.rewardsText, styles.rewardsRow, { color: mutedText }]}>
              {availableRewardsCount === 1
                ? t("economy.rewards_remaining_one", {
                    count: availableRewardsCount,
                    defaultValue: "You still have {{count}} way to earn free rewards.",
                  })
                : t("economy.rewards_remaining_other", {
                    count: availableRewardsCount,
                    defaultValue: "You still have {{count}} ways to earn free rewards.",
                  })}
              {" "}
              <Text style={[styles.rewardsLink, { color: accentText }]} onPress={onOpenRewards}>
                {t("economy.see_rewards", { defaultValue: "See rewards" })}
              </Text>
            </Text>
          ) : null}

          <View style={styles.actions}>
            <TouchableOpacity activeOpacity={0.85} style={[styles.secondaryButton, { backgroundColor: bg, borderColor: border }]} onPress={onClose}>
              <Text style={[styles.secondaryButtonText, { color: text }]}>
                {t("common.not_now", { defaultValue: "Not now" })}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.85} style={[styles.primaryButton, { backgroundColor: cta }]} onPress={onOpenStore}>
              <Text style={[styles.primaryButtonText, { color: onCta }]}>
                {t("economy.offers_button", { defaultValue: "All offers" })}
              </Text>
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
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  secondaryButtonText: {
    fontWeight: "700",
  },
  primaryButton: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  primaryButtonText: {
    fontWeight: "800",
  },
});
