export interface ProductVariable {
  id: number;
  attributes: {
    SKU: string;
    Price: number;
    DiscountPrice?: number;
    IsPublished?: boolean;
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
          ColorCode?: string;
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
    selected_attribute_terms?: {
      data: Array<{
        id: number;
        attributes: {
          Title: string;
          product_attribute?: {
            data: {
              id: number;
              attributes: { Title: string };
            } | null;
          };
        };
      }>;
    };
    product_stock?: {
      data: {
        id: number;
        attributes: {
          Count: number;
          StockRevision?: number;
        };
      };
    };
    general_discounts?: {
      data: Array<{
        id: number;
        attributes: {
          Type: "Discount" | "Cash";
          Amount: number;
          IsActive: boolean;
          StartDate: string;
          EndDate: string;
        };
      }>;
    };
  };
}

export interface ProductVariableDisplay {
  id: number;
  sku: string;
  price: number;
  discountPrice?: number;
  stock: number;
  stockId?: number;
  stockRevision?: number;
  variable: string;
  isPublished: boolean;
  colorId?: number;
  sizeId?: number;
  modelId?: number;
  color?: string;
  colorCode?: string;
  size?: string;
  model?: string;
  genericAttributes?: Array<{
    attributeId: number;
    attribute: string;
    termId: number;
    term: string;
  }>;
  generalDiscounts?: Array<{
    id: number;
    attributes: {
      Type: "Discount" | "Cash";
      Amount: number;
      IsActive: boolean;
      StartDate: string;
      EndDate: string;
    };
  }>;
}
