import type { categoryResponseType } from "@/services/super-admin/product/category/getAll";
import type {
  CoverImageField,
  MediaDataItem,
} from "@/services/super-admin/product/get";
import type { TagResponseType } from "@/services/super-admin/product/tag/get";
export interface ProductColorGallery {
  id?: number;
  color: number;
  Images: MediaDataItem[];
}
export interface ProductData {
  Title: string;
  Slug?: string;
  CoverImage: CoverImageField | null;
  Description: string;
  Status: "Active" | "InActive" | "Scheduled";
  ProductType: "Variable" | "Simple";
  IsSimpleProduct: boolean;
  SimpleSKU?: string;
  SimplePrice?: number;
  SimpleDiscountPrice?: number | null;
  SimpleStock?: number;
  SimpleIsPublished?: boolean;
  Weight?: number;
  Media: string[];
  ColorGalleries?: ProductColorGallery[];
  product_main_category: categoryResponseType | null;
  product_tags: TagResponseType[];
  Files: string[];
  product_other_categories: categoryResponseType[];
}
export interface EditProductData {
  Title: string;
  Slug?: string;
  CoverImage: CoverImageField | null;
  Description: string;
  Status: "Active" | "InActive" | "Scheduled";
  scheduledPublishAt?: string | null;
  scheduledPublishTimezone?: string | null;
  scheduledPublishLastAttemptAt?: string | null;
  scheduledPublishLastError?: string | null;
  scheduledPublishFailureKind?: "Transient" | "Permanent" | null;
  ProductType: "Variable" | "Simple";
  IsSimpleProduct: boolean;
  SimpleVariationId?: number;
  SimpleStockId?: number;
  SimpleStockRevision?: number;
  SimpleSKU?: string;
  SimplePrice?: number;
  SimpleDiscountPrice?: number | null;
  SimpleStock?: number;
  SimpleIsPublished?: boolean;
  Weight?: number;
  Media: MediaDataItem[];
  ColorGalleries?: ProductColorGallery[];
  product_main_category: categoryResponseType | null;
  product_tags: TagResponseType[];
  Files: MediaDataItem[];
  product_other_categories: categoryResponseType[];
}
