"use client";
import { useState } from "react";
import AttributeChip from "./AttributeChip";

type Props = {
  models: {
    id: string;
    title: string;
    available?: boolean; // optional: mark directly as available/unavailable
    stock?: number; // optional: stock count
  }[];
  onModelChange?: (modelId: string) => void;
  selectedModel?: string;
  disabledModelIds?: string[]; // manual fallback
};

export default function PDPHeroInfoModel(props: Props) {
  const {
    models,
    onModelChange,
    selectedModel: externalSelectedModel,
    disabledModelIds = [],
  } = props;

  // --- 🔹 auto-compute disabled models ---
  const getDisabledModelIds = () => {
    const autoDisabled = models
      .filter((model) => {
        if (model.available === false) return true; // explicitly unavailable
        if (model.stock !== undefined && model.stock <= 0) return true; // no stock
        return false;
      })
      .map((m) => m.id);

    return Array.from(new Set([...autoDisabled, ...disabledModelIds]));
  };

  const actualDisabledModelIds = getDisabledModelIds();

  // --- 🔹 default select the first *available* model ---
  const [internalSelectedModel, setInternalSelectedModel] = useState<string>(
    models.find((m) => !actualDisabledModelIds.includes(m.id))?.id || "",
  );

  // Use either external prop or internal state
  const selectedModel =
    externalSelectedModel !== undefined ? externalSelectedModel : internalSelectedModel;

  const handleModelClick = (modelId: string) => {
    if (actualDisabledModelIds.includes(modelId)) return; // safety
    setInternalSelectedModel(modelId);
    if (onModelChange) {
      onModelChange(modelId);
    }
  };

  if (!models.length) return null;

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xl text-neutral-800">انتخاب مدل</span>

      <div
        className="flex flex-wrap gap-2"
        role="radiogroup"
        aria-label="انتخاب مدل محصول"
      >
        {models.map((model) => {
          const isSelected = model.id === selectedModel;
          const isDisabled = actualDisabledModelIds.includes(model.id);
          return (
            <AttributeChip
              key={model.id}
              title={model.title}
              selected={isSelected}
              disabled={isDisabled}
              onClick={() => handleModelClick(model.id)}
              ariaLabel={isDisabled ? `مدل ${model.title} ناموجود` : `انتخاب مدل ${model.title}`}
              dataProps={{
                "data-testid": "pdp-model-option",
                "data-model-id": model.id,
                "data-model-title": model.title,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
