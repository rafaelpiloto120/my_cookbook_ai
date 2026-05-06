import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { MaterialIcons } from "@expo/vector-icons";

type VisibleIngredient = {
  index: number;
  key: string;
  name: string;
  quantity: string;
  unitLabel: string;
};

type UnitOption = {
  value: string;
  label: string;
};

type NutritionField = {
  key: string;
  label: string;
  value: string;
  unit?: string;
  onChange: (value: string) => void;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  closeOnBackdropPress?: boolean;
  modalBackdrop: string;
  card: string;
  border: string;
  bg: string;
  text: string;
  subText: string;
  cta: string;
  headingLabel: string;
  titleLabel: string;
  titleValue: string;
  onChangeTitle: (value: string) => void;
  mealDetailsStepLabel: string;
  nutritionStepLabel: string;
  quantitiesLabel: string;
  quantitiesNote?: string | null;
  hideIngredientsEditor?: boolean;
  visibleIngredients: VisibleIngredient[];
  allIngredientsCount: number;
  onChangeIngredientQuantity: (index: number, value: string) => void;
  onRemoveIngredient: (index: number) => void;
  emptyIngredientsText: string;
  showAllIngredients: boolean;
  showIngredientsToggle: boolean;
  onToggleShowAllIngredients: () => void;
  showAllIngredientsText: string;
  showFewerIngredientsText: string;
  addIngredientPlaceholder: string;
  newIngredientName: string;
  onChangeNewIngredientName: (value: string) => void;
  newIngredientQuantity: string;
  onChangeNewIngredientQuantity: (value: string) => void;
  newIngredientUnitLabel: string;
  unitDropdownOpen: boolean;
  onToggleUnitDropdown: () => void;
  unitOptions: UnitOption[];
  selectedUnitValue: string;
  onSelectUnit: (value: string) => void;
  onAddIngredient: () => void;
  nutritionLabel: string;
  nutritionHintAuto: string;
  nutritionHintManual: string;
  nutritionLoading?: boolean;
  nutritionLoadingLabel?: string;
  nutritionMode: "auto" | "manual";
  onChangeNutritionMode: (mode: "auto" | "manual") => void;
  nutritionFields: NutritionField[];
  autoLabel: string;
  manualLabel: string;
  cancelLabel: string;
  backLabel: string;
  nextLabel: string;
  saveLabel: string;
  onOpenNutritionStep?: () => void;
  onSave: () => void;
  saveDisabled: boolean;
};

export default function MyDayMealEditorModal({
  visible,
  onClose,
  closeOnBackdropPress = true,
  modalBackdrop,
  card,
  border,
  bg,
  text,
  subText,
  cta,
  headingLabel,
  titleLabel,
  titleValue,
  onChangeTitle,
  mealDetailsStepLabel,
  nutritionStepLabel,
  quantitiesLabel,
  quantitiesNote,
  hideIngredientsEditor = false,
  visibleIngredients,
  allIngredientsCount,
  onChangeIngredientQuantity,
  onRemoveIngredient,
  emptyIngredientsText,
  showAllIngredients,
  showIngredientsToggle,
  onToggleShowAllIngredients,
  showAllIngredientsText,
  showFewerIngredientsText,
  addIngredientPlaceholder,
  newIngredientName,
  onChangeNewIngredientName,
  newIngredientQuantity,
  onChangeNewIngredientQuantity,
  newIngredientUnitLabel,
  unitDropdownOpen,
  onToggleUnitDropdown,
  unitOptions,
  selectedUnitValue,
  onSelectUnit,
  onAddIngredient,
  nutritionLabel,
  nutritionHintAuto,
  nutritionHintManual,
  nutritionLoading = false,
  nutritionLoadingLabel,
  nutritionMode,
  onChangeNutritionMode,
  nutritionFields,
  autoLabel,
  manualLabel,
  cancelLabel,
  backLabel,
  nextLabel,
  saveLabel,
  onOpenNutritionStep,
  onSave,
  saveDisabled,
}: Props) {
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    if (visible) setCurrentStep(0);
  }, [visible]);

  const steps = [
    { label: mealDetailsStepLabel, icon: "restaurant-menu" as const },
    { label: nutritionStepLabel, icon: "monitor-heart" as const },
  ];

  const goToStep = (nextStep: number) => {
    setCurrentStep(nextStep);
    if (nextStep === 1) onOpenNutritionStep?.();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={[styles.modalOverlay, { backgroundColor: modalBackdrop }]}
        onPress={closeOnBackdropPress ? onClose : undefined}
      >
        <View
          style={[styles.modalCard, { backgroundColor: card, borderColor: border }]}
          onStartShouldSetResponder={() => true}
        >
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: text }]}>{headingLabel}</Text>
            <TouchableOpacity activeOpacity={0.8} onPress={onClose}>
              <MaterialIcons name="close" size={22} color={subText} />
            </TouchableOpacity>
          </View>

          <View style={styles.stepsRow}>
            {steps.map((step, index) => {
              const selected = index === currentStep;
              return (
                <TouchableOpacity
                  key={step.label}
                  activeOpacity={0.85}
                  style={styles.stepItem}
                  onPress={() => goToStep(index)}
                >
                  <View style={[styles.stepDot, { backgroundColor: selected ? cta : "transparent", borderColor: selected ? cta : border }]}>
                    <Text style={[styles.stepDotText, { color: selected ? "#fff" : subText }]}>{index + 1}</Text>
                  </View>
                  <View style={styles.stepLabelWrap}>
                    <MaterialIcons name={step.icon} size={14} color={selected ? cta : subText} />
                    <Text style={[styles.stepLabel, { color: selected ? text : subText, fontWeight: selected ? "700" : "500" }]}>
                      {step.label}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={[styles.headerDivider, { backgroundColor: border }]} />

          {currentStep === 0 ? (
            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.scrollContent}
            >
              <Text style={[styles.formLabelCompact, { color: text }]}>{titleLabel}</Text>
              <TextInput
                value={titleValue}
                onChangeText={onChangeTitle}
                style={[
                  styles.ingredientInput,
                  styles.ingredientInputEditable,
                  styles.mealTitleInput,
                  { color: text, borderColor: border, backgroundColor: "transparent" },
                ]}
                placeholderTextColor={subText}
              />

              <View style={styles.ingredientsWrap}>
                <Text style={[styles.formLabelCompact, { color: text }]}>{quantitiesLabel}</Text>
                {hideIngredientsEditor ? (
                  <Text style={[styles.modalHelp, { color: subText, marginTop: 4 }]}>{quantitiesNote}</Text>
                ) : (
                  <>
                {visibleIngredients.map((item) => (
                  <View key={item.key} style={styles.ingredientRow}>
                    <Text style={[styles.ingredientName, { color: text }]}>{item.name}</Text>
                    <TextInput
                      value={item.quantity}
                      onChangeText={(value) => onChangeIngredientQuantity(item.index, value)}
                      style={[
                        styles.ingredientInput,
                        styles.ingredientInputEditable,
                        { color: text, borderColor: border, backgroundColor: card },
                      ]}
                      placeholder="100"
                      placeholderTextColor={subText}
                      keyboardType="decimal-pad"
                      maxLength={8}
                    />
                    <Text style={[styles.ingredientUnitText, { color: subText }]}>{item.unitLabel}</Text>
                    <TouchableOpacity activeOpacity={0.8} onPress={() => onRemoveIngredient(item.index)} style={styles.ingredientRemoveButton}>
                      <MaterialIcons name="remove-circle-outline" size={18} color={subText} />
                    </TouchableOpacity>
                  </View>
                ))}

                {allIngredientsCount === 0 ? (
                  <Text style={[styles.modalHelp, { color: subText, marginTop: 4 }]}>{emptyIngredientsText}</Text>
                ) : null}

                <View style={styles.reviewComposer}>
                  <View style={styles.reviewComposerControls}>
                    <TextInput
                      value={newIngredientName}
                      onChangeText={onChangeNewIngredientName}
                      placeholder={addIngredientPlaceholder}
                      placeholderTextColor={subText}
                      style={[styles.reviewComposerNameInput, { color: text, borderColor: border, backgroundColor: card }]}
                      maxLength={60}
                    />
                    <TextInput
                      value={newIngredientQuantity}
                      onChangeText={onChangeNewIngredientQuantity}
                      placeholder="0"
                      placeholderTextColor={subText}
                      keyboardType="decimal-pad"
                      maxLength={8}
                      style={[styles.reviewComposerQuantityInput, { color: text, borderColor: border, backgroundColor: card }]}
                    />
                    <TouchableOpacity activeOpacity={0.85} style={styles.reviewComposerUnitButton} onPress={onToggleUnitDropdown}>
                      <Text style={[styles.reviewComposerUnitText, { color: text }]}>{newIngredientUnitLabel}</Text>
                      <MaterialIcons name="expand-more" size={16} color={subText} />
                    </TouchableOpacity>
                    <TouchableOpacity activeOpacity={0.85} style={styles.ingredientRemoveButton} onPress={onAddIngredient}>
                      <MaterialIcons name="add-circle-outline" size={18} color={cta} />
                    </TouchableOpacity>
                  </View>
                  {unitDropdownOpen ? (
                    <View style={[styles.reviewUnitDropdown, { borderColor: border, backgroundColor: card }]}>
                      {unitOptions.map((option) => (
                        <TouchableOpacity
                          key={option.value}
                          activeOpacity={0.85}
                          style={styles.reviewUnitDropdownItem}
                          onPress={() => onSelectUnit(option.value)}
                        >
                          <Text style={[styles.reviewUnitDropdownText, { color: option.value === selectedUnitValue ? cta : text }]}>
                            {option.label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ) : null}
                </View>

                {showIngredientsToggle ? (
                  <TouchableOpacity activeOpacity={0.8} style={styles.reviewToggleButton} onPress={onToggleShowAllIngredients}>
                    <Text style={[styles.reviewToggleText, { color: cta }]}>
                      {showAllIngredients ? showFewerIngredientsText : showAllIngredientsText}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                  </>
                )}
              </View>
            </ScrollView>
          ) : (
            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.scrollContent}
            >
              <View style={styles.planStepWrap}>
                <View style={styles.planHeader}>
                  <View style={styles.planHeaderCopy}>
                    <Text style={[styles.sectionLabel, { color: text }]}>{nutritionLabel}</Text>
                    <Text style={[styles.planHint, { color: subText }]}>
                      {nutritionMode === "auto" ? nutritionHintAuto : nutritionHintManual}
                    </Text>
                    {nutritionMode === "auto" && nutritionLoading && nutritionLoadingLabel ? (
                      <View style={styles.planLoadingRow}>
                        <ActivityIndicator size="small" color={cta} />
                        <Text style={[styles.planHint, styles.planLoadingText, { color: subText }]}>
                          {nutritionLoadingLabel}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>

                <View style={styles.modeWrap}>
                  <TouchableOpacity
                    activeOpacity={0.85}
                    style={[styles.modeButton, { backgroundColor: nutritionMode === "auto" ? cta : "transparent", borderColor: border }]}
                    onPress={() => onChangeNutritionMode("auto")}
                  >
                    <MaterialIcons name="auto-awesome" size={14} color={nutritionMode === "auto" ? "#fff" : text} />
                    <Text style={[styles.modeButtonText, { color: nutritionMode === "auto" ? "#fff" : text }]}>
                      {autoLabel}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    activeOpacity={0.85}
                    style={[styles.modeButton, { backgroundColor: nutritionMode === "manual" ? cta : "transparent", borderColor: border }]}
                    onPress={() => onChangeNutritionMode("manual")}
                  >
                    <MaterialIcons name="edit-note" size={15} color={nutritionMode === "manual" ? "#fff" : text} />
                    <Text style={[styles.modeButtonText, { color: nutritionMode === "manual" ? "#fff" : text }]}>
                      {manualLabel}
                    </Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.planGrid}>
                  {[nutritionFields.slice(0, 2), nutritionFields.slice(2, 4)].map((row, rowIndex) => (
                    <View key={`nutrition-row-${rowIndex}`} style={styles.planGridRow}>
                      {row.map((field) => (
                        <View
                          key={field.key}
                          style={[
                            styles.planGridCard,
                            { backgroundColor: bg },
                            nutritionMode === "auto" ? styles.planGridCardAuto : null,
                          ]}
                        >
                          <Text style={[styles.planMetricLabel, { color: subText }]}>{field.label}</Text>
                          {nutritionMode === "manual" ? (
                            <View style={styles.planGridManualWrap}>
                              <View style={styles.planGridManualInputRow}>
                                <TextInput
                                  value={field.value}
                                  onChangeText={field.onChange}
                                  keyboardType="decimal-pad"
                                  style={[styles.planMetricInputInline, { color: text, borderColor: border, backgroundColor: card }]}
                                  placeholder="0"
                                  placeholderTextColor={subText}
                                />
                                <Text style={[styles.planMetricUnitInline, { color: subText }]}>{field.unit ?? ""}</Text>
                              </View>
                            </View>
                          ) : (
                            <View style={styles.planGridValueWrap}>
                              <Text style={[styles.planMetricValueInline, { color: text }]}>{field.value}</Text>
                              {field.unit ? (
                                <Text style={[styles.planMetricUnitInline, { color: subText }]}>{field.unit}</Text>
                              ) : null}
                            </View>
                          )}
                        </View>
                      ))}
                    </View>
                  ))}
                </View>
              </View>
            </ScrollView>
          )}

          <View style={styles.actions}>
            {currentStep === 0 ? (
              <>
                <TouchableOpacity activeOpacity={0.85} style={[styles.secondaryButton, { borderColor: border, backgroundColor: bg }]} onPress={onClose}>
                  <Text style={[styles.secondaryButtonText, { color: text }]}>{cancelLabel}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[styles.primaryButton, { backgroundColor: cta, opacity: saveDisabled ? 0.7 : 1 }]}
                  onPress={() => goToStep(1)}
                  disabled={saveDisabled}
                >
                  <Text style={styles.primaryButtonText}>{nextLabel}</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TouchableOpacity activeOpacity={0.85} style={[styles.secondaryButton, { borderColor: border, backgroundColor: bg }]} onPress={() => goToStep(0)}>
                  <Text style={[styles.secondaryButtonText, { color: text }]}>{backLabel}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[styles.primaryButton, { backgroundColor: saveDisabled ? border : cta, opacity: saveDisabled ? 0.7 : 1 }]}
                  onPress={onSave}
                  disabled={saveDisabled}
                >
                  <Text style={styles.primaryButtonText}>{saveLabel}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    padding: 16,
  },
  modalCard: {
    width: "100%",
    alignSelf: "center",
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
    maxHeight: "88%",
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "800",
  },
  stepsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    marginBottom: 12,
    paddingBottom: 4,
  },
  headerDivider: {
    height: StyleSheet.hairlineWidth,
    marginBottom: 16,
  },
  stepItem: {
    flex: 1,
    alignItems: "center",
    gap: 4,
  },
  stepLabelWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  stepDot: {
    width: 22,
    height: 22,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  stepDotText: {
    fontSize: 11,
    fontWeight: "800",
  },
  stepLabel: {
    fontSize: 13,
    textAlign: "center",
  },
  scrollContent: {
    paddingBottom: 4,
  },
  formLabelCompact: {
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  ingredientRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
  },
  ingredientName: {
    flex: 1.2,
    fontSize: 13,
    fontWeight: "600",
  },
  ingredientInput: {
    width: 72,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13,
    textAlign: "center",
    transform: [{ translateX: -8 }],
  },
  ingredientInputEditable: {
    borderWidth: 1,
  },
  ingredientUnitText: {
    minWidth: 44,
    fontSize: 13,
    fontWeight: "600",
  },
  ingredientRemoveButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  mealTitleInput: {
    paddingHorizontal: 12,
    width: "100%",
    textAlign: "left",
    transform: [{ translateX: 0 }],
    marginBottom: 6,
  },
  ingredientsWrap: {
    marginTop: 18,
  },
  modalHelp: {
    fontSize: 13,
    lineHeight: 18,
  },
  reviewComposer: {
    marginTop: 10,
  },
  reviewComposerControls: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    gap: 10,
  },
  reviewComposerNameInput: {
    flex: 1.2,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13,
  },
  reviewComposerQuantityInput: {
    width: 72,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13,
    textAlign: "center",
    marginLeft: "auto",
  },
  reviewComposerUnitButton: {
    minWidth: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 2,
  },
  reviewComposerUnitText: {
    fontSize: 13,
    fontWeight: "600",
  },
  reviewUnitDropdown: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  reviewUnitDropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  reviewUnitDropdownText: {
    fontSize: 13,
    fontWeight: "600",
  },
  reviewToggleButton: {
    marginTop: 8,
  },
  reviewToggleText: {
    fontSize: 13,
    fontWeight: "700",
  },
  sectionLabel: {
    fontSize: 14,
    fontWeight: "800",
    marginBottom: 8,
  },
  planStepWrap: {
    marginTop: 4,
  },
  planHint: {
    fontSize: 13,
    lineHeight: 18,
  },
  planLoadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  planLoadingText: {
    flex: 1,
  },
  planHeader: {
    marginBottom: 8,
  },
  planHeaderCopy: {
    paddingRight: 0,
  },
  modeWrap: {
    flexDirection: "row",
    gap: 4,
    flexShrink: 0,
    marginTop: 6,
    marginBottom: 12,
    alignSelf: "stretch",
  },
  modeButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 34,
  },
  modeButtonText: {
    flexShrink: 1,
    fontWeight: "700",
    fontSize: 13,
    lineHeight: 16,
    textAlign: "center",
  },
  planGrid: {
    marginTop: 0,
  },
  planGridRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  planGridCard: {
    width: "48.5%",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 92,
    justifyContent: "space-between",
  },
  planGridCardAuto: {
    justifyContent: "center",
    alignItems: "center",
  },
  planMetricLabel: {
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    textAlign: "center",
  },
  planGridManualWrap: {
    marginTop: 10,
  },
  planGridManualInputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
  },
  planMetricInputInline: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 14,
    textAlign: "center",
    flex: 1,
  },
  planGridValueWrap: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  planMetricValueInline: {
    fontSize: 21,
    fontWeight: "800",
    lineHeight: 23,
  },
  planMetricUnitInline: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 2,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 14,
  },
  secondaryButton: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: "700",
  },
  primaryButton: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
});
