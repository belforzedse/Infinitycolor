import { apiClient } from "@/services";
import { ENDPOINTS } from "@/constants/api";
import { toast } from "react-hot-toast";
import { ProductEditorSession, type ProductEditorClient } from "./editor-session";
import { getProduct } from "./get";

// --- Generic Strapi response wrappers ---
interface StrapiItem<T = any> {
  id: number;
  attributes: T;
}

interface StrapiRelation<T = any> {
  data: StrapiItem<T> | null;
}

interface StrapiRelationList<T = any> {
  data: StrapiItem<T>[];
}

interface ProductAttributes {
  Title: string;
  Description?: string;
  Status?: string;
  ProductType?: "Variable" | "Simple" | null;
  IsSimpleProduct?: boolean | null;
  Weight?: number;
  CleaningTips?: string;
  ReturnConditions?: string;
  Files?: StrapiRelationList;
  Media?: StrapiRelationList;
  CoverImage?: StrapiRelation;
  product_main_category?: StrapiRelation;
  product_tags?: StrapiRelationList;
  product_other_categories?: StrapiRelationList;
  product_variations?: StrapiRelationList;
  product_size_helper?: StrapiRelation;
}

// --- Main function ---
export const duplicateProduct = async (productId: string) => {
  // Variations are copied one at a time and a failure does not abort the run,
  // so track how many did not make it across.
  let failedVariationCount = 0;
  let followupFailed = false;
  let createdProductId: number | null = null;
  let newSession: ProductEditorSession | null = null;
  let writer: ProductEditorClient = apiClient;
  try {
    // Get the original product with all relations
    const originalProduct = await getProduct(productId, {
      Files: true,
      Media: true,
      CoverImage: true,
      product_main_category: true,
      product_tags: true,
      product_variations: true,
      product_other_categories: true,
      product_size_helper: true,
    });

    // Normalize to our safer ProductAttributes shape
    const originalData = originalProduct.data
      .attributes as unknown as ProductAttributes;

    // Prepare data for duplicate
    const duplicatedProductType =
      originalData.ProductType === "Simple" || originalData.IsSimpleProduct
        ? "Simple"
        : "Variable";
    const duplicateData = {
      Title: `${originalData.Title} - کپی`,
      Description: originalData.Description,
      ProductType: duplicatedProductType,
      IsSimpleProduct: duplicatedProductType === "Simple",
      Weight: originalData.Weight ?? 100,
      CleaningTips: originalData.CleaningTips,
      ReturnConditions: originalData.ReturnConditions,
      Files: originalData.Files?.data?.map((file) => file.id) || [],
      Media: originalData.Media?.data?.map((media) => media.id) || [],
      CoverImage: originalData.CoverImage?.data?.id || null,
      product_main_category:
        originalData.product_main_category?.data?.id || null,
      product_tags: originalData.product_tags?.data?.map((tag) => tag.id) || [],
      product_other_categories:
        originalData.product_other_categories?.data?.map((cat) => cat.id) || [],
    };

    // Create duplicate product
    const response = await apiClient.post<StrapiItem<ProductAttributes>>(
      ENDPOINTS.PRODUCT.PRODUCT,
      { data: duplicateData },
      { retries: 0 },
    );

    const newProductId = response.data.id;
    createdProductId = newProductId;
    newSession = new ProductEditorSession(newProductId, () => undefined);
    await newSession.open(true);
    if (newSession.state.phase !== "editing") throw new Error("Could not start duplicate product editing");
    writer = newSession.client;

    // Clone the generic attribute configuration before variations so product-scoped
    // terms can be remapped to their new owner. Global definitions remain shared.
    const genericTermIdMap = new Map<number, number>();
    try {
      const assignmentResponse = await apiClient.get<any>(
        `/product-attribute-assignments?filters[product][id][$eq]=${productId}&populate[product_attribute]=true&populate[terms]=true&pagination[pageSize]=100`,
        { cache: "no-store" },
      );
      const assignments = assignmentResponse.data || [];
      for (const assignment of assignments) {
        const assignmentData = assignment.attributes || assignment;
        const definition = assignmentData.product_attribute?.data;
        const definitionData = definition?.attributes || definition;
        const originalTerms = assignmentData.terms?.data || [];
        let definitionId = definition?.id;
        const assignedTermIds: number[] = [];

        if (definitionData?.Scope === "Product") {
          const createdDefinitionResponse = await writer.post<any>(
            "/product-attributes",
            {
              data: {
                Title: definitionData.Title,
                Slug: definitionData.Slug,
                Scope: "Product",
                Type: definitionData.Type,
                LegacyProjection: definitionData.LegacyProjection || "None",
                Position: definitionData.Position || 0,
                owner_product: newProductId,
              },
            },
          );
          const createdDefinition =
            createdDefinitionResponse.data || createdDefinitionResponse;
          definitionId = createdDefinition.id;

          for (const originalTerm of originalTerms) {
            const termData = originalTerm.attributes || originalTerm;
            const createdTermResponse = await writer.post<any>(
              "/product-attribute-terms",
              {
                data: {
                  Title: termData.Title,
                  Slug: termData.Slug,
                  ColorCode: termData.ColorCode || null,
                  Position: termData.Position || 0,
                  product_attribute: definitionId,
                },
              },
            );
            const createdTerm = createdTermResponse.data || createdTermResponse;
            genericTermIdMap.set(
              Number(originalTerm.id),
              Number(createdTerm.id),
            );
            assignedTermIds.push(Number(createdTerm.id));
          }
        } else {
          originalTerms.forEach((term: any) => {
            genericTermIdMap.set(Number(term.id), Number(term.id));
            assignedTermIds.push(Number(term.id));
          });
        }

        if (definitionId && assignedTermIds.length > 0) {
          await writer.post<any>("/product-attribute-assignments", {
            data: {
              product: newProductId,
              product_attribute: definitionId,
              terms: assignedTermIds,
              Position: assignmentData.Position || 0,
              IsVisible: assignmentData.IsVisible !== false,
              IsVariation: assignmentData.IsVariation !== false,
            },
          });
        }
      }
    } catch (attributeError) {
      followupFailed = true;
      console.warn(
        "Failed to duplicate generic product attributes:",
        attributeError,
      );
    }

    // Duplicate product variations
    if (originalData.product_variations?.data?.length) {
      const variationErrors: string[] = [];

      for (const variation of originalData.product_variations.data) {
        try {
          const variationResponse = await apiClient.get<any>(
            `/product-variations/${variation.id}?populate=*`,
          );

          // apiClient.get returns response.data, which is { data: { id, attributes } } from Strapi
          // So variationResponse is { data: { id, attributes } }
          const variationItem = variationResponse.data || variationResponse;
          const variationData = variationItem.attributes || variationItem;

          if (!variationData || !variationData.SKU) {
            console.warn(
              `Variation ${variation.id} missing SKU or data, skipping`,
            );
            variationErrors.push(
              `Variation ${variation.id}: Missing SKU or data`,
            );
            continue;
          }

          // Extract relation IDs properly
          const productVariationColor =
            variationData.product_variation_color?.data?.id || null;
          const productVariationSize =
            variationData.product_variation_size?.data?.id || null;
          const productVariationModel =
            variationData.product_variation_model?.data?.id || null;
          const selectedAttributeTermIds = (
            variationData.selected_attribute_terms?.data || []
          )
            .map(
              (term: any) =>
                genericTermIdMap.get(Number(term.id)) || Number(term.id),
            )
            .filter((id: number) => Number.isFinite(id) && id > 0);

          const newVariationData: any = {
            SKU: `${variationData.SKU}-copy-${Date.now()}`,
            Price: variationData.Price,
            DiscountPrice: variationData.DiscountPrice || null,
            IsPublished: false,
            product: newProductId,
            selected_attribute_terms: selectedAttributeTermIds,
          };

          // Only add relation fields if they exist
          if (productVariationColor !== null) {
            newVariationData.product_variation_color = productVariationColor;
          }
          if (productVariationSize !== null) {
            newVariationData.product_variation_size = productVariationSize;
          }
          if (productVariationModel !== null) {
            newVariationData.product_variation_model = productVariationModel;
          }

          const newVariationResponse = await writer.post<any>(
            `/product-variations`,
            { data: newVariationData },
          );

          // apiClient.post returns response.data, which is { data: { id, attributes } } from Strapi
          const newVariationItem =
            newVariationResponse.data || newVariationResponse;
          const newVariationId =
            newVariationItem.id || newVariationItem.data?.id;

          if (!newVariationId) {
            throw new Error(`Failed to get new variation ID from response`);
          }

          // Duplicate stock with 0 count
          if (variationData.product_stock?.data) {
            await writer.post<any>(`/product-stocks`, {
              data: {
                Count: 0,
                product_variation: newVariationId,
              },
            });
          }
        } catch (variationError: any) {
          const errorMsg =
            variationError?.response?.data?.error?.message ||
            variationError?.message ||
            "Unknown error";
          console.error(
            `Failed to duplicate variation ${variation.id}:`,
            variationError,
          );
          variationErrors.push(`Variation ${variation.id}: ${errorMsg}`);
          // Continue with next variation instead of failing entire operation
        }
      }

      // Individual variation failures do not abort the copy, but they must not
      // be hidden either: a product whose variations did not come across is not
      // sellable, and reporting plain success sent the operator away believing
      // the duplicate was complete.
      if (variationErrors.length > 0) {
        console.warn(`Some variations failed to duplicate:`, variationErrors);
        failedVariationCount = variationErrors.length;
      }
    }

    // Duplicate size guide if it exists
    if (originalData.product_size_helper?.data) {
      try {
        const sizeHelperId = originalData.product_size_helper.data.id;
        const sizeHelperResponse = await apiClient.get<any>(
          `/product-size-helpers/${sizeHelperId}?populate=*`,
        );

        // apiClient.get returns response.data, which is { data: { id, attributes } } from Strapi
        const sizeHelperItem = sizeHelperResponse.data || sizeHelperResponse;
        const sizeHelperData = sizeHelperItem.attributes || sizeHelperItem;

        if (sizeHelperData?.Helper) {
          await writer.post<any>(`/product-size-helpers`, {
            data: {
              product: newProductId,
              Helper: sizeHelperData.Helper,
            },
          });
        }
      } catch (sizeHelperError: any) {
        followupFailed = true;
        // Log error but don't fail the entire operation
        console.warn("Failed to duplicate size guide:", sizeHelperError);
      }
    }

    if (failedVariationCount > 0) {
      toast.error(
        `محصول کپی شد اما ${failedVariationCount} تنوع منتقل نشد. پیش از انتشار، تنوع‌های محصول جدید را بررسی کنید.`,
      );
    } else if (followupFailed) {
      toast.error("نسخه محصول ساخته شد؛ ویژگی‌ها و راهنمای سایز آن را بررسی کنید");
    } else {
      toast.success("محصول با موفقیت کپی شد");
    }
    return {
      success: true,
      data: response.data,
      newProductId,
      failedVariationCount,
      followupFailed,
    };
  } catch (error: any) {
    if (createdProductId) {
      toast.error("نسخه محصول ساخته شد؛ تکمیل اطلاعات آن انجام نشد");
      return { success: true, newProductId: createdProductId, followupFailed: true, failedVariationCount };
    }
    console.error("Product duplication error:", error);
    const errorMessage =
      error.response?.data?.error?.message || "خطا در کپی کردن محصول";
    toast.error(errorMessage);
    return { success: false, error };
  } finally { if (newSession) { await newSession.release(); newSession.dispose(); } }
};
