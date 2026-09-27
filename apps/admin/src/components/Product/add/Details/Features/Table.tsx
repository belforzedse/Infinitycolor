import DeleteIcon from "@/components/Kits/Icons/DeleteIcon";
import React, { Fragment, useState, useEffect, useCallback, useRef } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { apiClient } from "@/services";
import toast from "react-hot-toast";
import { HexColorPicker, HexColorInput } from "react-colorful";
import { Pencil } from "lucide-react";
import {
  extractErrorMessage,
  translateErrorMessage,
} from "@/lib/errorTranslations";
import AsyncSearchPicker from "@/components/Kits/Form/AsyncSearchPicker";
import { renderColorOption } from "./colorOption";
import ReplaceColorDialog from "./ReplaceColorDialog";
import { ENDPOINTS } from "@/constants/api";
import { apiCache } from "@/lib/api-cache";
import {
  searchAttributeTerms,
  searchColors,
  searchModels,
  searchSizes,
  type VariationOption,
} from "@/services/product/variation-options";

interface Feature {
  id: string;
  value: string;
  colorCode?: string;
  /** Built into at least one saved variation, as opposed to picked but not generated yet. */
  persisted?: boolean;
}

interface ApiFeature {
  id: number;
  attributes: {
    Title: string;
    ColorCode?: string;
    [key: string]: any;
  };
}

interface ApiResponse<T> {
  data: T;
  meta?: any;
}

interface ProductVariation {
  id: number;
  attributes: {
    product: {
      data: {
        id: number;
      };
    };
    product_variation_color?: {
      data: {
        id: number;
        attributes: {
          Title: string;
        };
      };
    };
    product_variation_size?: {
      data: {
        id: number;
        attributes: {
          Title: string;
        };
      };
    };
    product_variation_model?: {
      data: {
        id: number;
        attributes: {
          Title: string;
        };
      };
    };
    SKU?: string;
    Price?: number;
    DiscountPrice?: number;
  };
}

interface FeatureGroup {
  colors: Feature[];
  sizes: Feature[];
  models: Feature[];
  generic: GenericFeatureGroup[];
}

interface GenericFeatureGroup {
  assignmentId: number;
  attributeId: number;
  title: string;
  type: "Text" | "Color";
  position: number;
  terms: Feature[];
}

/**
 * A definition offered in the "add attribute" dropdown. Values are not carried
 * here: each attached row searches its own terms on demand, so the dropdown only
 * needs identity.
 */
interface GenericAttributeOption {
  id: number;
  title: string;
  type: "Text" | "Color";
  position: number;
}

interface FeaturesTableProps {
  productId: number;
  onVariationsGenerated?: () => void;
  /** Bumped when variations changed elsewhere (e.g. one variation's colour), to re-read the axes. */
  axesRefreshKey?: number;
}

const COLOR_PALETTE = [
  "#000000",
  "#1f2937",
  "#374151",
  "#4b5563",
  "#6b7280",
  "#94a3b8",
  "#cbd5f5",
  "#ffffff",
  "#f5f5f5",
  "#e5e7eb",
  "#991b1b",
  "#dc2626",
  "#f87171",
  "#fee2e2",
  "#f97316",
  "#fb923c",
  "#fed7aa",
  "#fef3c7",
  "#facc15",
  "#a16207",
  "#ca8a04",
  "#84cc16",
  "#22c55e",
  "#16a34a",
  "#0d9488",
  "#14b8a6",
  "#2dd4bf",
  "#06b6d4",
  "#0ea5e9",
  "#2563eb",
  "#1d4ed8",
  "#3b82f6",
  "#60a5fa",
  "#818cf8",
  "#a855f7",
  "#d946ef",
  "#ec4899",
  "#f472b6",
  "#f9a8d4",
  "#fda4af",
  "#fb7185",
  "#f43f5e",
  "#be185d",
  "#831843",
  "#475569",
  "#334155",
];

const ATTRIBUTE_ENDPOINTS = {
  colors: ENDPOINTS.PRODUCT.COLORS,
  sizes: ENDPOINTS.PRODUCT.SIZES,
  models: ENDPOINTS.PRODUCT.MODELS,
} as const;

// DEFAULT_TITLES removed - sizes and models are now optional, no default values should be used

export const FeaturesTable = ({
  productId,
  onVariationsGenerated,
  axesRefreshKey = 0,
}: FeaturesTableProps) => {
  const [features, setFeatures] = useState<FeatureGroup>({
    colors: [],
    sizes: [],
    models: [],
    generic: [],
  });

  const [isGeneratingVariations, setIsGeneratingVariations] = useState(false);
  const [colorToReplace, setColorToReplace] = useState<Feature | null>(null);
  const [variationsCount, setVariationsCount] = useState(0);
  const [availableGenericAttributes, setAvailableGenericAttributes] = useState<
    GenericAttributeOption[]
  >([]);
  const [selectedGenericAttributeId, setSelectedGenericAttributeId] =
    useState("");
  const [isAddingAssignment, setIsAddingAssignment] = useState(false);
  /**
   * Per-row busy set, not one global flag. Each attached attribute now has its
   * own value picker, so a single flag would freeze every row whenever any one
   * of them was saving — and two quick picks on the same row would both compute
   * the new term list from the same stale state, losing the first.
   */
  const [savingAssignmentIds, setSavingAssignmentIds] = useState<Set<number>>(
    new Set(),
  );

  /**
   * One stable search function per attribute id.
   *
   * The picker keeps `search` in an effect dependency list, so handing it a
   * freshly-built closure on every parent render would re-run the query on every
   * render. Cached in a ref, which never needs to trigger one.
   */
  const termSearchCacheRef = useRef(
    new Map<number, (query: string) => Promise<VariationOption[]>>(),
  );
  const termSearchFor = (attributeId: number) => {
    const cache = termSearchCacheRef.current;
    let search = cache.get(attributeId);
    if (!search) {
      search = searchAttributeTerms(attributeId);
      cache.set(attributeId, search);
    }
    return search;
  };

  // Picker inputs are uncontrolled from here; each one owns its own query state.
  const selectedColorIds = new Set(features.colors.map((color) => color.id));
  const selectedSizeIds = new Set(features.sizes.map((size) => size.id));
  const selectedModelIds = new Set(features.models.map((model) => model.id));

  const markAssignmentSaving = (assignmentId: number, saving: boolean) => {
    setSavingAssignmentIds((prev) => {
      const next = new Set(prev);
      if (saving) next.add(assignmentId);
      else next.delete(assignmentId);
      return next;
    });
  };
  const [colorModal, setColorModal] = useState({
    isOpen: false,
    name: "",
    colorCode: "#000000",
    noColor: false,
  });
  const [creationLoading, setCreationLoading] = useState({
    colors: false,
    sizes: false,
    models: false,
  });

  const createAttributeOption = async (
    type: "colors" | "sizes" | "models",
    payload: { Title: string; ColorCode?: string },
  ) => {
    const title = payload.Title?.trim();
    if (!title) {
      toast.error("نام ویژگی نمی‌تواند خالی باشد");
      return null;
    }

    setCreationLoading((prev) => ({ ...prev, [type]: true }));
    try {
      const response = await apiClient.post<ApiFeature>(
        ATTRIBUTE_ENDPOINTS[type],
        {
          data: payload,
        },
      );
      const created = response.data;

      // The pickers now read through the 60s colour/size/model cache instead of
      // holding a prefetched catalogue, so a newly created option has to be
      // invalidated or searches would not find it for another minute.
      apiCache.clearByPattern(/product-variation-(colors|sizes|models)/i);

      addFeature(type, {
        id: String(created.id),
        title: created.attributes.Title,
        colorCode: created.attributes.ColorCode,
      });
      toast.success(`${title} با موفقیت اضافه شد`);
      return created;
    } catch (error: any) {
      console.error("Error creating variation option:", error);
      const rawErrorMessage = extractErrorMessage(error);
      const message = translateErrorMessage(
        rawErrorMessage,
        "خطا در ایجاد ویژگی جدید. لطفاً دوباره تلاش کنید.",
      );
      toast.error(message);
      return null;
    } finally {
      setCreationLoading((prev) => ({ ...prev, [type]: false }));
    }
  };

  const openColorModal = (prefill?: string) => {
    setColorModal({
      isOpen: true,
      name: prefill?.trim() || "",
      colorCode: "#000000",
      noColor: false,
    });
  };

  const closeColorModal = () =>
    setColorModal((prev) => ({
      ...prev,
      isOpen: false,
    }));

  const handleColorChange = (value: string) => {
    if (!value) {
      return;
    }
    const normalized = value.startsWith("#") ? value : `#${value}`;
    setColorModal((prev) => ({
      ...prev,
      colorCode: normalized.toLowerCase(),
    }));
  };

  const handleSaveColor = async () => {
    if (!colorModal.name.trim()) {
      toast.error("نام رنگ را وارد کنید");
      return;
    }
    // Colorless entries omit ColorCode entirely; otherwise send the chosen hex.
    const colorPayload: { Title: string; ColorCode?: string } = {
      Title: colorModal.name.trim(),
    };
    if (!colorModal.noColor && colorModal.colorCode) {
      colorPayload.ColorCode = colorModal.colorCode;
    }

    const saved = await createAttributeOption("colors", colorPayload);
    if (saved) {
      closeColorModal();
    }
  };

  const handleCreateTextOption = async (
    type: "sizes" | "models",
    label: string,
  ) => {
    await createAttributeOption(type, { Title: label.trim() });
  };

  /**
   * Catalogue of generic attribute definitions for the "add attribute" dropdown.
   *
   * Values are no longer fetched with the definition — each attached row searches
   * its own terms on demand — so this only needs the identity fields.
   */
  const loadGenericAttributeDefinitions = useCallback(async () => {
    try {
      const response = await apiClient.get<ApiResponse<any[]>>(
        `${ENDPOINTS.PRODUCT.ATTRIBUTES}?filters[LegacyProjection][$eq]=None` +
          `&pagination[pageSize]=100&sort=Position:asc`,
        { cache: "no-store" },
      );
      setAvailableGenericAttributes(
        (((response as any).data || []) as any[])
          .map((attribute): GenericAttributeOption | null => {
            const value = attribute.attributes || attribute;
            if (!attribute.id) return null;
            return {
              id: Number(attribute.id),
              title: String(value.Title || ""),
              type: value.Type === "Color" ? "Color" : "Text",
              position: Number(value.Position || 0),
            };
          })
          .filter((attribute): attribute is GenericAttributeOption =>
            Boolean(attribute),
          ),
      );
    } catch (error) {
      console.error("Error fetching attribute definitions:", error);
      toast.error("خطا در دریافت ویژگی‌ها");
    }
  }, []);

  /**
   * The product's own attribute assignments.
   *
   * Writes only the `generic` slice. It used to be one loader that rebuilt the
   * whole `features` object, so attaching an attribute discarded any colour or
   * size the user had picked but not yet generated variations from.
   */
  const loadProductAssignments = useCallback(async () => {
    if (!productId) {
      setFeatures((prev) => ({ ...prev, generic: [] }));
      return;
    }
    try {
      const response = await apiClient.get<ApiResponse<any[]>>(
        `${ENDPOINTS.PRODUCT.ATTRIBUTE_ASSIGNMENTS}?filters[product][id][$eq]=${productId}` +
          `&filters[IsVariation][$eq]=true&populate[product_attribute]=true&populate[terms]=true` +
          `&pagination[pageSize]=100&sort=Position:asc`,
        { cache: "no-store" },
      );
      const generic = (((response as any).data || []) as any[])
        .map((assignment): GenericFeatureGroup | null => {
          const attributes = assignment.attributes || assignment;
          const definition = attributes.product_attribute?.data;
          if (!definition?.id) return null;
          const definitionAttributes = definition.attributes || definition;
          if (definitionAttributes.LegacyProjection !== "None") return null;
          const terms = (attributes.terms?.data || [])
            .map((term: any) => ({
              id: String(term.id),
              value: String(term.attributes?.Title || term.Title || ""),
              colorCode: term.attributes?.ColorCode || term.ColorCode,
            }))
            .filter((term: Feature) => term.id && term.value);
          // An assignment with no values yet is kept deliberately: attributes are
          // now attached empty and filled in afterwards, so dropping empty ones
          // would make a freshly added attribute invisible.
          return {
            assignmentId: Number(assignment.id),
            attributeId: Number(definition.id),
            title: String(definitionAttributes.Title || ""),
            type: definitionAttributes.Type === "Color" ? "Color" : "Text",
            position: Number(attributes.Position || 0),
            terms,
          };
        })
        .filter((group): group is GenericFeatureGroup => Boolean(group))
        .sort((left, right) => left.position - right.position);

      setFeatures((prev) => ({ ...prev, generic }));
    } catch (error) {
      console.error("Error fetching product attribute assignments:", error);
      toast.error("خطا در دریافت مقادیر ویژگی‌های محصول");
    }
  }, [productId]);

  /**
   * Seeds the colour/size/model rows from variations that already exist, so an
   * edited product opens showing the axes it was built from. Writes only those
   * three slices.
   */
  const loadExistingVariationAxes = useCallback(async () => {
    if (!productId) {
      setFeatures((prev) => ({ ...prev, colors: [], sizes: [], models: [] }));
      return;
    }
    try {
      const response = await apiClient.get<ApiResponse<ProductVariation[]>>(
        `/product-variations?filters[product][id][$eq]=${productId}` +
          `&populate=product_variation_color,product_variation_size,product_variation_model` +
          `&pagination[pageSize]=100`,
        // Kept: /product-variations is cached for 30s, and this must reflect a
        // generation that just happened.
        { cache: "no-store" },
      );
      const existingVariations = (response as any).data || [];

      const existingColors = new Map<string, Feature>();
      const existingSizes = new Map<string, Feature>();
      const existingModels = new Map<string, Feature>();

      existingVariations.forEach((variation: any) => {
        if (variation.attributes.product_variation_color?.data) {
          const colorData = variation.attributes.product_variation_color.data;
          existingColors.set(String(colorData.id), {
            id: String(colorData.id),
            value: colorData.attributes.Title,
            colorCode: colorData.attributes.ColorCode,
            persisted: true,
          });
        }

        if (variation.attributes.product_variation_size?.data) {
          const sizeData = variation.attributes.product_variation_size.data;
          existingSizes.set(String(sizeData.id), {
            id: String(sizeData.id),
            value: sizeData.attributes.Title,
            persisted: true,
          });
        }

        if (variation.attributes.product_variation_model?.data) {
          const modelData = variation.attributes.product_variation_model.data;
          existingModels.set(String(modelData.id), {
            id: String(modelData.id),
            value: modelData.attributes.Title,
            persisted: true,
          });
        }
      });

      // Saved values come from the server; picks not generated yet are kept, so a
      // re-read after a colour change elsewhere does not throw them away.
      const merge = (saved: Map<string, Feature>, previous: Feature[]) => [
        ...saved.values(),
        ...previous.filter((feature) => !feature.persisted && !saved.has(feature.id)),
      ];
      setFeatures((prev) => ({
        ...prev,
        colors: merge(existingColors, prev.colors),
        sizes: merge(existingSizes, prev.sizes),
        models: merge(existingModels, prev.models),
      }));
    } catch (error) {
      console.error("Error fetching existing variations:", error);
      toast.error("خطا در دریافت تنوع‌های موجود");
    }
  }, [productId]);

  // Independent, so one failing endpoint no longer blanks the whole editor.
  useEffect(() => {
    void loadGenericAttributeDefinitions();
    void loadProductAssignments();
    void loadExistingVariationAxes();
  }, [
    loadGenericAttributeDefinitions,
    loadProductAssignments,
    loadExistingVariationAxes,
  ]);

  // Skips the initial 0: the mount effect above already did the first read.
  useEffect(() => {
    if (axesRefreshKey > 0) void loadExistingVariationAxes();
  }, [axesRefreshKey, loadExistingVariationAxes]);

  const handleColorReplaced = async () => {
    await loadExistingVariationAxes();
    onVariationsGenerated?.();
  };

  // Generate combinations and calculate potential variations count
  useEffect(() => {
    // Don't use default values - if sizes/models are empty, they won't be included
    const sizeCount = features.sizes.length > 0 ? features.sizes.length : 1;
    const modelCount = features.models.length > 0 ? features.models.length : 1;
    const colorCount = features.colors.length > 0 ? features.colors.length : 1;
    const genericCount = features.generic.reduce(
      (count, group) => count * Math.max(group.terms.length, 1),
      1,
    );
    const hasAnyAxis =
      features.colors.length > 0 ||
      features.sizes.length > 0 ||
      features.models.length > 0 ||
      features.generic.some((group) => group.terms.length > 0);
    const potentialVariationsCount = hasAnyAxis
      ? colorCount * sizeCount * modelCount * genericCount
      : 0;

    setVariationsCount(potentialVariationsCount);
  }, [features]);

  const addFeature = (
    type: "colors" | "sizes" | "models",
    option: VariationOption,
  ) => {
    const isDuplicate = features[type].some(
      (feature) => feature.id === option.id,
    );
    if (isDuplicate) return;

    setFeatures((prev) => ({
      ...prev,
      [type]: [
        ...prev[type],
        { id: option.id, value: option.title, colorCode: option.colorCode },
      ],
    }));
  };

  const removeFeature = (type: "colors" | "sizes" | "models", id: string) => {
    setFeatures((prev) => ({
      ...prev,
      [type]: prev[type].filter((feature) => feature.id !== id),
    }));
  };

  /**
   * Persists an assignment's value list.
   *
   * The assignment's `terms` is what the storefront PDP renders as the option
   * list, so a value change that only touched React state left shoppers being
   * offered values the admin had removed. Every add and remove writes through.
   *
   * Pessimistic: state is committed from `nextTerms` only after the server
   * accepts, so a failed write leaves the row exactly as it was.
   */
  const saveAssignmentTerms = async (
    group: GenericFeatureGroup,
    nextTerms: Feature[],
    successMessage: string,
    failureMessage: string,
  ) => {
    markAssignmentSaving(group.assignmentId, true);
    try {
      await apiClient.put(
        `${ENDPOINTS.PRODUCT.ATTRIBUTE_ASSIGNMENTS}/${group.assignmentId}`,
        { data: { terms: nextTerms.map((term) => Number(term.id)) } },
      );
      setFeatures((prev) => ({
        ...prev,
        generic: prev.generic.map((candidate) =>
          candidate.assignmentId === group.assignmentId
            ? { ...candidate, terms: nextTerms }
            : candidate,
        ),
      }));
      toast.success(successMessage);
      return true;
    } catch (error) {
      console.error("Error saving attribute assignment terms:", error);
      toast.error(
        translateErrorMessage(extractErrorMessage(error), failureMessage),
      );
      return false;
    } finally {
      markAssignmentSaving(group.assignmentId, false);
    }
  };

  const addGenericTerm = async (
    group: GenericFeatureGroup,
    option: VariationOption,
  ) => {
    if (group.terms.some((term) => term.id === option.id)) return;
    await saveAssignmentTerms(
      group,
      [
        ...group.terms,
        { id: option.id, value: option.title, colorCode: option.colorCode },
      ],
      `«${option.title}» افزوده شد`,
      "ثبت مقدار ویژگی با خطا مواجه شد",
    );
  };

  const removeGenericTerm = async (
    group: GenericFeatureGroup,
    termId: string,
  ) => {
    const removed = group.terms.find((term) => term.id === termId);
    const saved = await saveAssignmentTerms(
      group,
      group.terms.filter((term) => term.id !== termId),
      `«${removed?.value ?? ""}» حذف شد`,
      "حذف مقدار ویژگی با خطا مواجه شد",
    );
    // Variation generation is strictly additive — it never prunes — so any
    // variation already built from this value survives its removal. Say so
    // rather than letting the count silently disagree with the option list.
    if (saved && variationsCount > 0) {
      toast("تنوع‌های ساخته‌شده با این مقدار حذف نمی‌شوند", { icon: "ℹ️" });
    }
  };

  const addGenericAssignment = async () => {
    const attributeId = Number(selectedGenericAttributeId);
    const attribute = availableGenericAttributes.find(
      (item) => item.id === attributeId,
    );
    if (!attribute || !productId) return;
    // The backend rejects an attribute configured more than once on a product,
    // and it is not recoverable from this UI, so refuse the duplicate here.
    if (features.generic.some((group) => group.attributeId === attributeId)) {
      toast.error("این ویژگی قبلاً به محصول افزوده شده است");
      return;
    }

    setIsAddingAssignment(true);
    try {
      const response = await apiClient.post<{ id: number }>(
        ENDPOINTS.PRODUCT.ATTRIBUTE_ASSIGNMENTS,
        {
          data: {
            product: productId,
            product_attribute: attribute.id,
            // Attached empty on purpose. Sending the definition's whole term list
            // dumped every possible value onto the product; values are chosen one
            // at a time afterwards, like every other row in this table.
            terms: [],
            Position: attribute.position,
            IsVisible: true,
            IsVariation: true,
          },
        },
      );

      // Merge locally instead of refetching everything: a full reload rebuilt
      // colours/sizes/models from existing variations and so threw away any axis
      // the user had picked but not yet generated.
      const assignmentId = Number((response as any).data?.id ?? (response as any).id);
      setFeatures((prev) => ({
        ...prev,
        generic: [
          ...prev.generic,
          {
            assignmentId,
            attributeId: attribute.id,
            title: attribute.title,
            type: attribute.type,
            position: attribute.position,
            terms: [],
          },
        ].sort((left, right) => left.position - right.position),
      }));
      setSelectedGenericAttributeId("");
      toast.success("ویژگی به محصول افزوده شد");
    } catch (error) {
      console.error("Error adding attribute assignment:", error);
      toast.error(
        translateErrorMessage(
          extractErrorMessage(error),
          "افزودن ویژگی به محصول با خطا مواجه شد",
        ),
      );
    } finally {
      setIsAddingAssignment(false);
    }
  };

  const removeGenericAssignment = async (assignmentId: number) => {
    markAssignmentSaving(assignmentId, true);
    try {
      await apiClient.delete(
        `${ENDPOINTS.PRODUCT.ATTRIBUTE_ASSIGNMENTS}/${assignmentId}`,
      );
      setFeatures((prev) => ({
        ...prev,
        generic: prev.generic.filter(
          (group) => group.assignmentId !== assignmentId,
        ),
      }));
      toast.success("ویژگی از محصول حذف شد");
    } catch (error) {
      console.error("Error removing attribute assignment:", error);
      toast.error(
        translateErrorMessage(
          extractErrorMessage(error),
          "حذف ویژگی از محصول با خطا مواجه شد",
        ),
      );
    } finally {
      markAssignmentSaving(assignmentId, false);
    }
  };

  const generateVariations = async () => {
    if (!productId || isGeneratingVariations) return;

    try {
      setIsGeneratingVariations(true);
      const axes = [
        ...(features.colors.length > 0
          ? [
              {
                type: "color",
                termIds: features.colors.map((term) => Number(term.id)),
              },
            ]
          : []),
        ...(features.sizes.length > 0
          ? [
              {
                type: "size",
                termIds: features.sizes.map((term) => Number(term.id)),
              },
            ]
          : []),
        ...(features.models.length > 0
          ? [
              {
                type: "model",
                termIds: features.models.map((term) => Number(term.id)),
              },
            ]
          : []),
        ...features.generic
          .filter((group) => group.terms.length > 0)
          .map((group) => ({
            type: "attribute",
            attributeId: group.attributeId,
            termIds: group.terms.map((term) => Number(term.id)),
          })),
      ];
      if (axes.length === 0) {
        toast.error("حداقل یک ویژگی و یک مقدار انتخاب کنید");
        return;
      }

      const response = await apiClient.post<any>(
        `/products/${productId}/variation-combinations`,
        {
          axes,
        },
      );
      const result = response.data || response;

      // Generation is the one moment the server knows more than this component
      // does, so re-read both slices it can have changed.
      await Promise.all([loadExistingVariationAxes(), loadProductAssignments()]);
      onVariationsGenerated?.();

      if (!result.created) {
        toast("هیچ تنوع جدیدی برای ایجاد وجود نداشت");
      } else {
        // New variations start at price 0 and can't be sold until priced -- a
        // bulk price set just before generating does not reach them.
        toast.success(
          `${result.created} تنوع جدید ایجاد شد. قیمت و موجودی آن‌ها را وارد کنید؛ تنوع بدون قیمت فروخته نمی‌شود.`,
          { duration: 8000 },
        );
      }
    } catch (error) {
      console.error("Error generating variations:", error);
      toast.error("خطا در ایجاد تنوع‌های محصول");
    } finally {
      setIsGeneratingVariations(false);
    }
  };

  return (
    <>
      <div className="space-y-4">
        <div className="w-full rounded-xl border border-slate-100">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="w-[20%] border-l border-slate-100 px-4 py-2 text-right font-normal text-gray-900">
                  ویژگی
                </th>
                <th className="w-[80%] px-4 py-2 text-right font-normal text-gray-900">
                  مقدارها
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-100">
                <td className="border-l border-slate-100 px-4 py-3 text-right text-sm text-gray-900">
                  رنگ
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {features.colors.map((color) => (
                      <div
                        key={color.id}
                        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1"
                      >
                        <span
                          className="h-4 w-4 rounded-full border border-slate-200"
                          style={{
                            backgroundColor: color.colorCode || "#f5f5f5",
                          }}
                          aria-label={`کد رنگ ${color.colorCode || "نامشخص"}`}
                        />
                        <span className="text-sm text-slate-500">
                          {color.value}
                        </span>
                        {color.persisted && (
                          // Removing the chip only drops it from the next
                          // generation; a wrong built colour is fixed by moving
                          // its variations onto another colour.
                          <button
                            type="button"
                            onClick={() => setColorToReplace(color)}
                            className="flex items-center gap-1 rounded-md px-1 text-xs text-blue-600 hover:bg-blue-50 hover:text-blue-700"
                            aria-label={`تغییر رنگ ${color.value}`}
                            title="تغییر این رنگ در تنوع‌های ساخته‌شده، بدون ساخت دوباره"
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            تغییر رنگ
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => removeFeature("colors", color.id)}
                          className="text-slate-400"
                          aria-label={`حذف رنگ ${color.value}`}
                        >
                          <DeleteIcon />
                        </button>
                      </div>
                    ))}
                    <AsyncSearchPicker
                      placeholder="جستجوی رنگ..."
                      search={searchColors}
                      selectedIds={selectedColorIds}
                      onPick={(option) => addFeature("colors", option)}
                      renderOption={renderColorOption}
                      onCreate={(query) => openColorModal(query)}
                      createLabel={(query) => `افزودن رنگ «${query}»`}
                      createDisabled={creationLoading.colors}
                    />
                    <button
                      type="button"
                      disabled={creationLoading.colors}
                      onClick={() => openColorModal()}
                      className={`rounded-full border border-dashed border-slate-200 px-3 py-1 text-xs transition ${
                        creationLoading.colors
                          ? "cursor-not-allowed text-slate-400"
                          : "text-blue-600 hover:border-blue-400 hover:text-blue-700"
                      }`}
                    >
                      افزودن رنگ دلخواه
                    </button>
                  </div>
                </td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="border-l border-slate-100 px-4 py-3 text-right text-sm text-gray-900">
                  سایز
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {features.sizes.map((size) => (
                      <div
                        key={size.id}
                        className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-100 px-2 py-1"
                      >
                        <span className="text-sm text-slate-500">
                          {size.value}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeFeature("sizes", size.id)}
                          className="text-slate-400"
                          aria-label={`حذف سایز ${size.value}`}
                        >
                          <DeleteIcon />
                        </button>
                      </div>
                    ))}
                    <AsyncSearchPicker
                      placeholder="جستجوی سایز..."
                      search={searchSizes}
                      selectedIds={selectedSizeIds}
                      onPick={(option) => addFeature("sizes", option)}
                      onCreate={(query) => handleCreateTextOption("sizes", query)}
                      createLabel={(query) => `افزودن سایز «${query}»`}
                      createDisabled={creationLoading.sizes}
                    />
                  </div>
                </td>
              </tr>
              <tr>
                <td className="border-l border-slate-100 px-4 py-3 text-right text-sm text-gray-900">
                  مدل
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {features.models.map((model) => (
                      <div
                        key={model.id}
                        className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-100 px-2 py-1"
                      >
                        <span className="text-sm text-slate-500">
                          {model.value}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeFeature("models", model.id)}
                          className="text-slate-400"
                          aria-label={`حذف مدل ${model.value}`}
                        >
                          <DeleteIcon />
                        </button>
                      </div>
                    ))}
                    <AsyncSearchPicker
                      placeholder="جستجوی مدل..."
                      search={searchModels}
                      selectedIds={selectedModelIds}
                      onPick={(option) => addFeature("models", option)}
                      onCreate={(query) => handleCreateTextOption("models", query)}
                      createLabel={(query) => `افزودن مدل «${query}»`}
                      createDisabled={creationLoading.models}
                    />
                  </div>
                </td>
              </tr>
              {availableGenericAttributes.some(
                (attribute) =>
                  !features.generic.some(
                    (group) => group.attributeId === attribute.id,
                  ),
              ) && (
                <tr className="border-t border-slate-100">
                  <td className="border-l border-slate-100 px-4 py-3 text-right text-sm text-gray-900">
                    ویژگی عمومی
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <select
                        value={selectedGenericAttributeId}
                        onChange={(event) =>
                          setSelectedGenericAttributeId(event.target.value)
                        }
                        className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      >
                        <option value="">انتخاب ویژگی تعریف‌شده</option>
                        {availableGenericAttributes
                          .filter(
                            (attribute) =>
                              !features.generic.some(
                                (group) => group.attributeId === attribute.id,
                              ),
                          )
                          .map((attribute) => (
                            <option key={attribute.id} value={attribute.id}>
                              {attribute.title}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        disabled={
                          !selectedGenericAttributeId || isAddingAssignment
                        }
                        onClick={addGenericAssignment}
                        className="rounded-lg bg-slate-800 px-4 py-2 text-sm text-white disabled:opacity-50"
                      >
                        افزودن به محصول
                      </button>
                    </div>
                  </td>
                </tr>
              )}
              {features.generic.map((group) => {
                const isSaving = savingAssignmentIds.has(group.assignmentId);
                return (
                <tr
                  key={group.attributeId}
                  className="border-t border-slate-100"
                >
                  <td className="border-l border-slate-100 px-4 py-3 text-right text-sm text-gray-900">
                    <div className="flex items-center justify-between gap-2">
                      <span>{group.title}</span>
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() =>
                          removeGenericAssignment(group.assignmentId)
                        }
                        className="text-xs text-red-500 disabled:opacity-50"
                      >
                        {isSaving ? "در حال حذف..." : "حذف از محصول"}
                      </button>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-400">
                      ویژگی عمومی
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {group.terms.map((term) => (
                        <div
                          key={term.id}
                          className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-100 px-2 py-1"
                        >
                          {group.type === "Color" &&
                            /^#[0-9a-f]{6}$/i.test(term.colorCode || "") && (
                              <span
                                className="h-4 w-4 rounded-full border border-black/10"
                                style={{ backgroundColor: term.colorCode }}
                                aria-hidden="true"
                              />
                            )}
                          <span className="text-sm text-slate-500">
                            {term.value}
                          </span>
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={() =>
                              void removeGenericTerm(group, term.id)
                            }
                            className="text-slate-400 disabled:opacity-50"
                            aria-label={`حذف ${term.value}`}
                          >
                            <DeleteIcon />
                          </button>
                        </div>
                      ))}
                      {/*
                        Values are searched per attribute rather than dumped in
                        wholesale when the attribute is attached, so this row
                        behaves like the colour/size/model rows above it.
                        Inline creation is not offered: a Color-typed term needs a
                        ColorCode, which belongs in the attributes screen.
                      */}
                      <AsyncSearchPicker
                        placeholder={`جستجوی ${group.title}...`}
                        search={termSearchFor(group.attributeId)}
                        selectedIds={new Set(group.terms.map((term) => term.id))}
                        onPick={(option) => addGenericTerm(group, option)}
                        disabled={isSaving}
                      />
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between rounded-xl border border-slate-100 p-4">
          <div className="text-sm text-slate-600">
            <p>
              تعداد تنوع‌های محصول:{" "}
              <span className="font-semibold">{variationsCount}</span>
            </p>
            {variationsCount > 0 && (
              <p className="mt-1 text-xs">
                با ترکیب ویژگی‌های انتخاب شده {variationsCount} تنوع محصول ایجاد
                خواهد شد
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={generateVariations}
            disabled={isGeneratingVariations || variationsCount === 0}
            className={`rounded-lg px-4 py-2 text-sm text-white ${
              isGeneratingVariations || variationsCount === 0
                ? "bg-blue-300"
                : "bg-blue-600 hover:bg-blue-700"
            }`}
          >
            {isGeneratingVariations
              ? "در حال ایجاد تنوع‌ها..."
              : "ایجاد تنوع‌های محصول"}
          </button>
        </div>
      </div>

      <ReplaceColorDialog
        productId={productId}
        color={colorToReplace}
        onClose={() => setColorToReplace(null)}
        onReplaced={handleColorReplaced}
      />

      <Transition appear show={colorModal.isOpen} as={Fragment}>
        <Dialog
          as="div"
          className="relative z-[1300]"
          onClose={closeColorModal}
        >
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-200"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-150"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-black/30" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-200"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-150"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
              >
                <Dialog.Panel className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
                  <Dialog.Title className="text-lg font-medium text-neutral-900">
                    افزودن رنگ جدید
                  </Dialog.Title>
                  <div className="mt-4 space-y-4">
                    <div>
                      <label className="text-sm text-neutral-600">
                        نام رنگ
                      </label>
                      <input
                        type="text"
                        value={colorModal.name}
                        onChange={(e) => {
                          const newName = e.target.value;
                          // Auto-check "No Color" if name contains " کد" or starts with "کد"
                          const shouldAutoCheck =
                            newName.includes(" کد") || newName.startsWith("کد");

                          if (process.env.NODE_ENV === "development") {
                            console.log(
                              "Color name changed:",
                              newName,
                              "| Should auto-check:",
                              shouldAutoCheck,
                            );
                          }

                          setColorModal((prev) => ({
                            ...prev,
                            name: newName,
                            noColor: shouldAutoCheck ? true : prev.noColor,
                            colorCode: shouldAutoCheck ? "" : prev.colorCode,
                          }));
                        }}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
                        placeholder="مثلاً آبی آسمانی"
                      />
                    </div>

                    {/* No Color Checkbox */}
                    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <input
                        type="checkbox"
                        id="noColorCheckboxFeature"
                        checked={colorModal.noColor}
                        onChange={(e) =>
                          setColorModal((prev) => ({
                            ...prev,
                            noColor: e.target.checked,
                            colorCode: e.target.checked ? "" : prev.colorCode,
                          }))
                        }
                        className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                      <label
                        htmlFor="noColorCheckboxFeature"
                        className="cursor-pointer text-sm text-neutral-700"
                      >
                        بدون رنگ
                      </label>
                    </div>

                    <div>
                      <label className="text-sm text-neutral-600">
                        انتخاب رنگ
                      </label>
                      {!colorModal.noColor ? (
                        <>
                          <div className="mt-3 flex flex-col gap-4 md:flex-row">
                            <div className="flex-1">
                              <HexColorPicker
                                color={colorModal.colorCode}
                                onChange={handleColorChange}
                              />
                            </div>
                            <div className="flex-1 space-y-3">
                              <div>
                                <span className="text-xs text-neutral-500">
                                  کد HEX
                                </span>
                                <HexColorInput
                                  prefixed
                                  color={colorModal.colorCode}
                                  onChange={handleColorChange}
                                  aria-label="کد رنگ"
                                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm uppercase focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
                                />
                              </div>
                              <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                                <span
                                  className="h-10 w-10 rounded-lg border border-slate-200"
                                  style={{
                                    backgroundColor: colorModal.colorCode,
                                  }}
                                  aria-hidden="true"
                                />
                                <div className="text-xs text-neutral-500">
                                  <p className="font-medium text-neutral-700">
                                    نمونه رنگ انتخابی
                                  </p>
                                  <p>{colorModal.colorCode.toUpperCase()}</p>
                                </div>
                              </div>
                              <p className="text-xs text-neutral-500">
                                می‌توانید کد رنگ را بچسبانید یا از انتخاب‌گر
                                برای پیدا کردن دقیق‌ترین طیف استفاده کنید.
                              </p>
                            </div>
                          </div>
                          <div className="mt-4">
                            <p className="text-xs font-medium text-neutral-600">
                              رنگ‌های پر استفاده
                            </p>
                            <div className="mt-2 grid grid-cols-5 gap-2">
                              {COLOR_PALETTE.map((color) => (
                                <button
                                  type="button"
                                  key={color}
                                  onClick={() => handleColorChange(color)}
                                  className={`h-10 w-full rounded-lg border ${
                                    colorModal.colorCode.toLowerCase() ===
                                    color.toLowerCase()
                                      ? "border-blue-500 ring-2 ring-blue-200"
                                      : "border-slate-200"
                                  }`}
                                  style={{ backgroundColor: color }}
                                  aria-label={`انتخاب رنگ ${color}`}
                                />
                              ))}
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="mt-3 rounded-xl border border-slate-300 bg-slate-100 p-8">
                          <div className="flex flex-col items-center justify-center text-center">
                            <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-slate-200">
                              <svg
                                className="h-8 w-8 text-slate-500"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                                />
                              </svg>
                            </div>
                            <p className="text-sm font-medium text-slate-600">
                              برای تعیین رنگ گزینه بدون رنگ را خاموش کنید
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-6 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={closeColorModal}
                      className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-neutral-600"
                    >
                      انصراف
                    </button>
                    <button
                      type="button"
                      disabled={creationLoading.colors}
                      onClick={handleSaveColor}
                      className={`rounded-lg px-4 py-2 text-sm text-white ${
                        creationLoading.colors
                          ? "bg-blue-300"
                          : "bg-blue-600 hover:bg-blue-700"
                      }`}
                    >
                      ذخیره رنگ
                    </button>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition>
    </>
  );
};

export default FeaturesTable;
