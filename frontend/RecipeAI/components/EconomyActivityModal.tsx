import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";

import type { EconomyLedgerEntry } from "../lib/economy/client";
import { formatEconomyActivityDate, getEconomyActivityLabel } from "../lib/economy/activity";

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
  locale?: string;
  entries: EconomyLedgerEntry[];
  loading: boolean;
  onClose: () => void;
  t: (key: string, options?: any) => string;
};

export default function EconomyActivityModal({
  visible,
  isDark,
  card,
  border,
  text,
  subText,
  backdrop,
  title,
  loadingText,
  emptyText,
  balanceAfterLabel,
  locale,
  entries,
  loading,
  onClose,
  t,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.modalOverlay, { backgroundColor: backdrop }]} onPress={onClose}>
        <View
          style={[styles.modalContent, { backgroundColor: card, borderColor: border }]}
          onStartShouldSetResponder={() => true}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: isDark ? "#f5f5f5" : "#293a53" }]}>{title}</Text>
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
                const deltaColor = delta >= 0 ? "#2E8B57" : "#E27D60";
                const deltaPrefix = delta > 0 ? "+" : "";
                return (
                  <View
                    key={entry.id || `${entry.createdAt || "entry"}-${index}`}
                    style={[
                      styles.entryRow,
                      {
                        borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                        borderTopColor: border,
                      },
                    ]}
                  >
                    <View style={styles.entryContent}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: text, fontSize: 14, fontWeight: "700" }}>
                          {getEconomyActivityLabel(entry, t)}
                        </Text>
                        <Text style={{ color: subText, fontSize: 12, marginTop: 2 }}>
                          {formatEconomyActivityDate(entry.createdAt, locale)}
                        </Text>
                      </View>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={{ color: deltaColor, fontSize: 14, fontWeight: "800" }}>
                          {`${deltaPrefix}${delta}`}
                        </Text>
                        {typeof entry.balanceAfter === "number" ? (
                          <Text style={{ color: subText, fontSize: 12, marginTop: 2 }}>
                            {balanceAfterLabel.replace("{{count}}", String(entry.balanceAfter))}
                          </Text>
                        ) : null}
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
    paddingVertical: 12,
  },
  entryContent: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
});
