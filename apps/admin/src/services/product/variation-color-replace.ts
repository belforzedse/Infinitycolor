import { apiClient } from "@/services";
import type { ProductEditorClient } from "@/services/super-admin/product/editor-session";

/**
 * Re-points a product's variations from one colour to another in place, via
 * `POST /products/:id/variation-colors/replace`. Price, stock and publication
 * stay on each variation; only the colour it points at changes.
 */

export type ColorReplaceTarget =
  | { toColorId: number }
  | { newColor: { title: string; colorCode: string | null } };

export type ReplacedVariation = {
  id: number;
  label: string;
  sku: string | null;
  isPublished: boolean;
};

export type BlockingVariation = ReplacedVariation & {
  movingId: number;
  reason: "occupied" | "duplicate";
};

export type ColorReplaceResult = {
  productId: number;
  dryRun: boolean;
  fromColor: { id: number; title: string | null };
  targetColor: {
    id: number | null;
    title: string;
    colorCode: string | null;
    created: boolean;
  };
  moving: ReplacedVariation[];
  emptyDrafts: ReplacedVariation[];
  blocking: BlockingVariation[];
};

export async function replaceProductColor(
  productId: number,
  fromColorId: number,
  target: ColorReplaceTarget,
  options: { dryRun?: boolean; removeEmptyDrafts?: boolean } = {},
  client: ProductEditorClient = apiClient,
): Promise<ColorReplaceResult> {
  const response = await client.post<ColorReplaceResult>(
    `/products/${productId}/variation-colors/replace`,
    {
      fromColorId,
      ...target,
      dryRun: options.dryRun === true,
      removeEmptyDrafts: options.removeEmptyDrafts === true,
    },
    { retries: 0 },
  );
  return response.data;
}
