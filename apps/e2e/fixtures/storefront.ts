export const E2E_PRODUCT_TITLE = "E2E G001 Storefront Smoke Product";
export const E2E_PRODUCT_SLUG = "e2e-storefront-smoke-product";
export const E2E_CATEGORY_TITLE = "E2E Storefront Category";
export const E2E_CATEGORY_SLUG = "e2e-storefront";
export const E2E_HEX_COLOR_TITLE = "E2E Blue";
export const E2E_HEXLESS_COLOR_TITLE = "E2E No Hex";
export const E2E_UNAVAILABLE_COLOR_TITLE = "E2E Unavailable Black";
export const E2E_UPLOAD_FIXTURE_FILE = "Cyan_DM_id_WAHX_9y_Gx_0_ea75d58006.webp";

export const E2E_DEFAULT_CUSTOMER_PHONE = "+989000000101";
export const E2E_DEFAULT_CUSTOMER_PASSWORD = "E2eCustomer!123";
export const E2E_DEFAULT_ADMIN_PHONE = "+989000000201";
export const E2E_DEFAULT_ADMIN_PASSWORD = "E2eAdmin!123";

// Role-specific seeded users for super-admin CRUD and permission tests.
export const E2E_DEFAULT_FOUNDER_PHONE = "+989000000202";
export const E2E_DEFAULT_FOUNDER_PASSWORD = "E2eFounder!123";
export const E2E_DEFAULT_STORE_MANAGER_PHONE = "+989000000203";
export const E2E_DEFAULT_STORE_MANAGER_PASSWORD = "E2eManager!123";
export const E2E_DEFAULT_EDITOR_PHONE = "+989000000204";
export const E2E_DEFAULT_EDITOR_PASSWORD = "E2eEditor!123";

// Dedicated high-stock variation so repeated payment runs never exhaust inventory.
export const E2E_PAYMENT_VARIATION_SKU = "E2E-STOREFRONT-PAY";

// Checkout prerequisites seeded for the deterministic customer.
export const E2E_SHIPPING_TITLE = "E2E Shipping Method";
export const E2E_ADDRESS_POSTAL_CODE = "1234567890";
export const E2E_ADDRESS_FULL = "E2E deterministic address, plaque 1";

export const E2E_ADMIN_CATEGORY_TITLE = "E2E Admin CRUD Category";
export const E2E_ADMIN_CATEGORY_SLUG = "e2e-admin-crud-category";
export const E2E_ADMIN_CATEGORY_UPDATED_TITLE = "E2E Admin CRUD Category Updated";
export const E2E_ADMIN_CATEGORY_UPDATED_SLUG = "e2e-admin-crud-category-updated";

// Runtime entities created by admin CRUD specs are always named with this prefix
// so cleanup can find and remove them even when a test fails midway.
export const E2E_RUNTIME_PREFIX = "E2E_DO_NOT_USE_";
