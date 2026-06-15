import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";

import type { EconomyLedgerEntry } from "../lib/economy/client";
import { formatEconomyActivityDate, getEconomyActivityLabel } from "../lib/economy/activity";
import { useThemeColors } from "../context/ThemeContext";
import EggIcon from "./EggIcon";

type Props = {
  visible: boolean;
  isDark: boolean;
  card: string;
  border: string;
  text: string;
  subText: string;
  backdrop: string;
  title: string;
  loadingText: string;
  emptyText: string;
  balanceAfterLabel: string;
  positiveDeltaColor?: string;
  negativeDeltaColor?: string;
  locale?: string;
  entries: EconomyLedgerEntry[];
  loading: boolean;
  onClose: () => void;
  t: (key: string, options?: any) => string;
};

type ActivityIconKind = "free" | "purchase" | "spend";

function getActivityIconKind(entry: EconomyLedgerEntry): ActivityIconKind {
  const delta = typeof entry.delta === "number" ? entry.delta : 0;
  const reason = String(entry.reason || "").toLowerCase();
  const actionKey = String(entry.actionKey || "").toLowerCase();
  const kind = String(entry.kind || "").toLowerCase();
  const source = String(entry.source || "").toLowerCase();
  const metadataText = JSON.stringify(entry.metadata || {}).toLowerCase();
  const searchable = `${reason} ${actionKey} ${kind} ${source} ${metadataText}`;

  if (kind === "spend" || delta < 0) return "spend";
  if (
    reason === "purchase_verified" ||
    reason === "cookie_purchase" ||
    kind === "purchase" ||
    searchable.includes("purchase") ||
    searchable.includes("google") ||
    searchable.includes("play") ||
    searchable.includes("iap")
  ) {
    return "purchase";
  }

  return "free";
}

export default function EconomyActivityModal({
  visible,
  card,
  border,
  text,
  subText,
  backdrop,
  title,
  loadingText,
  emptyText,
  balanceAfterLabel,
  positiveDeltaColor,
  negativeDeltaColor,
  locale,
  entries,
  loading,
  onClose,
  t,
}: Props) {
  const { sectionTitle, success, accentText } = useThemeColors();

  const renderEntryIcon = (entry: EconomyLedgerEntry) => {
    const iconKind = getActivityIconKind(entry);
    if (iconKind === "purchase") {
      return <EggIcon size={17} />;
    }
    if (iconKind === "spend") {
      return <MaterialIcons name="auto-awesome" size={18} color={negativeDeltaColor ?? accentText} />;
    }
    return <MaterialIcons name="card-giftcard" size={18} color={accentText} />;
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.modalOverlay, { backgroundColor: backdrop }]} onPress={onClose}>
        <View
          style={[styles.modalContent, { backgroundColor: card, borderColor: border }]}
          onStartShouldSetResponder={() => true}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: sectionTitle }]}>{title}</Text>
            <Pressable style={styles.closeButton} onPress={onClose} hitSlop={12}>
              <MaterialIcons name="close" size={26} color={subText} />
            </Pressable>
          </View>

          {loading ? (
            <Text style={{ color: subText, fontSize: 14 }}>{loadingText}</Text>
          ) : entries.length === 0 ? (
            <Text style={{ color: subText, fontSize: 14 }}>{emptyText}</Text>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false}>
              {entries.map((entry, index) => {
                const delta = typeof entry.delta === "number" ? entry.delta : 0;
                const deltaColor = delta >= 0
                  ? positiveDeltaColor ?? success
                  : negativeDeltaColor ?? accentText;
                const deltaPrefix = delta > 0 ? "+" : "";
                return (
                  <View
                    key={entry.id || `${entry.createdAt || "entry"}-${index}`}
                    style={styles.entryRow}
                  >
                    <View style={styles.timelineRail}>
                      <View style={[styles.timelineDot, { backgroundColor: deltaColor }]} />
                      <View
                        style={[
                          styles.timelineLine,
                          { backgroundColor: index === entries.length - 1 ? "transparent" : delta >= 0 ? deltaColor : border },
                        ]}
                      />
                    </View>
                    <View style={styles.entryBody}>
                      <View style={styles.entryTopRow}>
                        <Text style={[styles.entryDate, { color: text }]}>
                          {formatEconomyActivityDate(entry.createdAt, locale)}
                        </Text>
                        {typeof entry.balanceAfter === "number" ? (
                          <Text style={[styles.entryBalanceAfter, { color: subText }]}>
                            {balanceAfterLabel.replace("{{count}}", String(entry.balanceAfter))}
                          </Text>
                        ) : null}
                      </View>
                      <View style={styles.entryDescriptionRow}>
                        <View style={styles.entryDescriptionCopy}>
                          <View style={styles.entryIconWrap}>
                            {renderEntryIcon(entry)}
                          </View>
                          <Text numberOfLines={2} style={[styles.entryDescription, { color: text }]}>
                            {getEconomyActivityLabel(entry, t)}
                          </Text>
                        </View>
                        <Text style={[styles.entryDelta, { color: deltaColor }]}>
                          {`${deltaPrefix}${delta}`}
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modalContent: {
    width: "100%",
    maxHeight: "72%",
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
  },
  closeButton: {
    marginLeft: 10,
    marginTop: -6,
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "stretch",
    minHeight: 62,
  },
  timelineRail: {
    width: 18,
    alignItems: "center",
    paddingTop: 18,
  },
  timelineDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  timelineLine: {
    width: 2,
    flex: 1,
    minHeight: 28,
    marginTop: 5,
    borderRadius: 999,
  },
  entryBody: {
    flex: 1,
    paddingLeft: 8,
    paddingVertical: 12,
  },
  entryTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 5,
  },
  entryDate: {
    flex: 1,
    fontSize: 12,
    fontWeight: "400",
    lineHeight: 16,
  },
  entryDelta: {
    fontSize: 14,
    fontWeight: "800",
    textAlign: "right",
    width: 118,
    flexShrink: 0,
  },
  entryBalanceAfter: {
    fontSize: 12,
    textAlign: "right",
    maxWidth: 118,
  },
  entryDescriptionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  entryDescriptionCopy: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  entryIconWrap: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  entryDescription: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
});
