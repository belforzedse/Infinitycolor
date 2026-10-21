"use client";

import { useAtom } from "jotai";
import { editProductDataAtom } from "@/atoms/super-admin/products";
import { useProductEditor } from "@/hooks/product/ProductEditorContext";
import { useCan } from "@/hooks/useCan";
import type { MediaDataItem } from "@/services/super-admin/product/get";
import ColorGalleryEditor from "./ColorGalleryEditor";

interface ProductColorGalleriesProps {
  colors: Array<{
    id: number;
    title: string;
  }>;
}

export default function ProductColorGalleries({
  colors,
}: ProductColorGalleriesProps) {
  const [productData, setProductData] = useAtom(editProductDataAtom);
  const { canEdit, state } = useProductEditor();
  const canUpdate = useCan("product.update");

  const uniqueColors = [
    ...new Map(colors.map((color) => [color.id, color])).values(),
  ];

  const updateImages = (colorId: number, images: MediaDataItem[]) => {
    if (!canEdit || state.busy || !canUpdate) return;

    setProductData((previous) => {
      const galleries = previous.ColorGalleries ?? [];
      const existing = galleries.find((gallery) => gallery.color === colorId);

      const updated = {
        ...existing,
        color: colorId,
        Images: images,
      };

      return {
        ...previous,
        ColorGalleries: existing
          ? galleries.map((gallery) =>
              gallery.color === colorId ? updated : gallery,
            )
          : [...galleries, updated],
      };
    });
  };

  if (uniqueColors.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-medium text-slate-800">تصاویر هر رنگ</h2>

      {uniqueColors.map((color) => (
        <ColorGalleryEditor
          key={color.id}
          colorTitle={color.title}
          images={
            productData.ColorGalleries?.find(
              (gallery) => gallery.color === color.id,
            )?.Images ?? []
          }
          onChange={(images) => updateImages(color.id, images)}
        />
      ))}
    </div>
  );
}
