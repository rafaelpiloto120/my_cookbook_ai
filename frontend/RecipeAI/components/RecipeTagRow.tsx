import React, { useMemo, useState } from "react";
import { LayoutChangeEvent, StyleSheet, Text, View } from "react-native";

import { useThemeColors } from "../context/ThemeContext";

type VisibleTag = {
  label: string;
  maxWidth?: number;
};

type Props = {
  tags: string[];
};

const ROW_HEIGHT = 26;
const TAG_GAP = 6;
const MIN_TRUNCATED_TAG_WIDTH = 34;

export default function RecipeTagRow({ tags }: Props) {
  const { secondary, onSecondary } = useThemeColors();
  const [containerWidth, setContainerWidth] = useState(0);
  const [tagWidths, setTagWidths] = useState<Record<string, number>>({});

  const uniqueTags = useMemo(
    () => tags.map((tag) => String(tag || "").trim()).filter(Boolean),
    [tags]
  );

  const onContainerLayout = (event: LayoutChangeEvent) => {
    const width = Math.floor(event.nativeEvent.layout.width);
    if (width !== containerWidth) {
      setContainerWidth(width);
    }
  };

  const visibleTags = useMemo<VisibleTag[]>(() => {
    if (containerWidth <= 0 || uniqueTags.length === 0) return [];

    const next: VisibleTag[] = [];
    let usedWidth = 0;

    for (const tag of uniqueTags) {
      const measuredWidth = tagWidths[tag];
      if (!measuredWidth) break;

      const gap = next.length > 0 ? TAG_GAP : 0;
      const fullWidth = Math.ceil(measuredWidth);

      if (usedWidth + gap + fullWidth <= containerWidth) {
        next.push({ label: tag });
        usedWidth += gap + fullWidth;
        continue;
      }

      const remainingWidth = containerWidth - usedWidth - gap;
      if (remainingWidth >= MIN_TRUNCATED_TAG_WIDTH || next.length === 0) {
        next.push({
          label: tag,
          maxWidth: Math.max(MIN_TRUNCATED_TAG_WIDTH, remainingWidth),
        });
      }
      break;
    }

    return next;
  }, [containerWidth, tagWidths, uniqueTags]);

  if (uniqueTags.length === 0) return null;

  return (
    <View style={styles.wrapper} onLayout={onContainerLayout}>
      <View pointerEvents="none" style={styles.measurementRow}>
        {uniqueTags.map((tag) => (
          <View
            key={`measure-${tag}`}
            style={[styles.tagChip, styles.measurementChip, { backgroundColor: secondary }]}
            onLayout={(event) => {
              const width = Math.ceil(event.nativeEvent.layout.width);
              setTagWidths((current) => (
                current[tag] === width ? current : { ...current, [tag]: width }
              ));
            }}
          >
            <Text style={[styles.tagText, { color: onSecondary }]}>{tag}</Text>
          </View>
        ))}
      </View>

      {visibleTags.map((tag, index) => (
        <View
          key={`${tag.label}-${index}`}
          style={[
            styles.tagChip,
            {
              backgroundColor: secondary,
              marginRight: index === visibleTags.length - 1 ? 0 : TAG_GAP,
              maxWidth: tag.maxWidth,
            },
          ]}
        >
          <Text
            style={[styles.tagText, { color: onSecondary }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {tag.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: "row",
    flexWrap: "nowrap",
    overflow: "hidden",
    height: ROW_HEIGHT,
  },
  measurementRow: {
    position: "absolute",
    opacity: 0,
    left: 0,
    top: 0,
    flexDirection: "row",
    flexWrap: "nowrap",
  },
  measurementChip: {
    marginRight: TAG_GAP,
  },
  tagChip: {
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 0,
    height: ROW_HEIGHT,
    justifyContent: "center",
    minWidth: 0,
  },
  tagText: {
    fontSize: 12,
    lineHeight: ROW_HEIGHT,
  },
});
