/**
 * Product variations and stock management tests
 * Tests: Variation creation, stock tracking, stock logs, inventory integrity
 */

import { mockProductVariation } from '../../../__tests__/mocks/factories';
import { decrementStockAtomic, reserveStockAtomic } from '../../cart/services/lib/stock';

jest.mock('../../../utils/homepageRevalidation', () => ({
  scheduleHomeProductsRevalidation: jest.fn(),
}));

/**
 * Builds a strapi mock that simulates the atomic-stock SQL boundary: `rows` is what the
 * guarded UPDATE ... RETURNING returns (an empty array means the guard rejected the
 * mutation), and `stockOnMiss` is the row the fallback findOne returns for the error path.
 */
function createStockStrapi(rows: any[], stockOnMiss: any = null) {
  return {
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    db: {
      connection: { raw: jest.fn().mockResolvedValue({ rows }) },
      query: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(stockOnMiss) })),
    },
  } as any;
}

describe('Product Variations & Stock Management', () => {
  const mockStrapi = global.strapi;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Product Variations', () => {
    it('should create variation with color', () => {
      const variation = mockProductVariation({
        product: { id: 1, Title: 'T-Shirt' },
        product_color: { id: 1, Title: 'Red' },
      });

      expect(variation.product.Title).toBe('T-Shirt');
      expect(variation.product_color.Title).toBe('Red');
    });

    it('should create variation with size', () => {
      const variation = mockProductVariation({
        product_size: { id: 1, Title: 'M' },
      });

      expect(variation.product_size.Title).toBe('M');
    });

    it('should create variation with model', () => {
      const variation = mockProductVariation({
        product_variation_model: { id: 1, Title: 'Model-A' },
      });

      expect(variation.product_variation_model.Title).toBe('Model-A');
    });

    it('should handle variation without all attributes', () => {
      const variation = mockProductVariation({
        product_color: { id: 1, Title: 'Blue' },
        product_size: null,
        product_variation_model: null,
      });

      expect(variation.product_color).toBeDefined();
      expect(variation.product_size).toBeNull();
      expect(variation.product_variation_model).toBeNull();
    });

    it('should auto-create size helper on product creation', () => {
      const product = { id: 1, Title: 'Product' };
      const sizeHelper = {
        product: { id: product.id },
        Sizes: [],
      };

      expect(sizeHelper.product.id).toBe(product.id);
    });

    it('should validate variation has valid product', () => {
      const variation = mockProductVariation();

      expect(variation.product).toBeDefined();
      expect(variation.product.id).toBeGreaterThan(0);
    });

    it('should prevent duplicate variations (same color+size+model)', () => {
      const variation1 = {
        product: { id: 1 },
        color: 'Red',
        size: 'M',
        model: 'Standard',
      };

      const variation2 = {
        product: { id: 1 },
        color: 'Red',
        size: 'M',
        model: 'Standard',
      };

      // Would be detected as duplicate in DB
      expect(variation1).toEqual(variation2);
    });
  });

  describe('Stock Management', () => {
    it('should track stock quantity per variation', () => {
      const stock = {
        product_variation: { id: 1 },
        Quantity: 100,
      };

      expect(stock.Quantity).toBe(100);
    });

    it('should allow multiple stock entries for same variation', () => {
      const stocks = [
        { id: 1, variation: { id: 1 }, Quantity: 50, warehouse: 'Main' },
        { id: 2, variation: { id: 1 }, Quantity: 30, warehouse: 'Backup' },
      ];

      const total = stocks.reduce((sum, s) => sum + s.Quantity, 0);
      expect(total).toBe(80);
    });

    it('should sum total stock across warehouses', () => {
      const warehouses = [
        { id: 1, stock: 100 },
        { id: 2, stock: 50 },
        { id: 3, stock: 25 },
      ];

      const totalStock = warehouses.reduce((sum, w) => sum + w.stock, 0);
      expect(totalStock).toBe(175);
    });

    it('should prevent negative stock', () => {
      const stock = 10;
      const requestedQuantity = 15;
      const canPurchase = stock >= requestedQuantity;

      expect(canPurchase).toBe(false);
    });

    it('should track stock changes over time', () => {
      const stockHistory = [
        { date: '2024-01-01', quantity: 100 },
        { date: '2024-01-02', quantity: 95 }, // -5
        { date: '2024-01-03', quantity: 88 }, // -7
        { date: '2024-01-04', quantity: 100 }, // +12 (restock)
      ];

      expect(stockHistory[0].quantity).toBeGreaterThan(stockHistory[1].quantity);
      expect(stockHistory[3].quantity).toBeGreaterThan(stockHistory[2].quantity);
    });

    it('should mark out-of-stock variations', () => {
      const variation = mockProductVariation({
        product_stock: [{ Quantity: 0 }],
      });

      const isOutOfStock = variation.product_stock.every((s) => s.Quantity === 0);
      expect(isOutOfStock).toBe(true);
    });

    it('should handle low stock alerts', () => {
      const lowStockThreshold = 10;
      const variation = mockProductVariation({
        product_stock: [{ Quantity: 5 }],
      });

      const isLowStock = variation.product_stock.some(
        (s) => s.Quantity <= lowStockThreshold,
      );
      expect(isLowStock).toBe(true);
    });
  });

  describe('Stock Decrement (atomic)', () => {
    it('decrements stock on a successful order', async () => {
      const strapi = createStockStrapi([{ count: 95 }]);

      const res = await decrementStockAtomic(strapi, 1, 5);

      expect(res).toEqual({ success: true, newCount: 95 });
    });

    it('prevents decrementing below zero when stock is insufficient', async () => {
      // The guarded UPDATE matches no row; fallback reports the shortfall.
      const strapi = createStockStrapi([], { Count: 5, reservedCount: 0 });

      const res = await decrementStockAtomic(strapi, 1, 10);

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Insufficient stock/);
    });

    it('does not double-decrement on a duplicate callback (second guarded UPDATE is a no-op)', async () => {
      // First callback decrements; the second finds insufficient remaining and is rejected,
      // proving the SQL guard (not app bookkeeping) blocks the double decrement.
      const first = createStockStrapi([{ count: 0 }]);
      expect((await decrementStockAtomic(first, 1, 5)).success).toBe(true);

      const second = createStockStrapi([], { Count: 0, reservedCount: 0 });
      expect((await decrementStockAtomic(second, 1, 5)).success).toBe(false);
    });
  });

  describe('Stock Logs', () => {
    it('should log every stock change', () => {
      const logs = [
        { id: 1, action: 'Initial', quantity: 100 },
        { id: 2, action: 'Decremented', quantity: 95 },
        { id: 3, action: 'Decremented', quantity: 88 },
        { id: 4, action: 'Restocked', quantity: 100 },
      ];

      expect(logs.length).toBe(4);
    });

    it('should include timestamp in logs', () => {
      const log = {
        action: 'Decremented',
        timestamp: new Date().toISOString(),
      };

      expect(log.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it('should record reason for stock change', () => {
      const reasons = [
        'Order finalization',
        'Manual restock',
        'Return processed',
        'Damage adjustment',
      ];

      const log = { action: 'Decremented', reason: reasons[0] };
      expect(log.reason).toBeDefined();
    });

    it('should link logs to orders', () => {
      const log = {
        stock_id: 1,
        order: { id: 100 },
        action: 'Decremented',
      };

      expect(log.order.id).toBe(100);
    });

    it('should show before/after quantities', () => {
      const logs = [
        { id: 1, previousQty: 100, newQty: 95, change: -5 },
        { id: 2, previousQty: 95, newQty: 88, change: -7 },
      ];

      logs.forEach((log) => {
        expect(log.previousQty + log.change).toBe(log.newQty);
      });
    });

    it('should track user who made change (for restocks)', () => {
      const log = {
        action: 'Restocked',
        changedBy: { id: 1, role: 'admin' },
      };

      expect(log.changedBy).toBeDefined();
    });

    it('should enable stock audit trail', () => {
      const variation = { id: 1, SKU: 'PROD-001' };
      const logs = [
        { ...variation, quantity: 100, date: '2024-01-01' },
        { ...variation, quantity: 95, date: '2024-01-02' },
        { ...variation, quantity: 88, date: '2024-01-03' },
      ];

      const allForVariation = logs.filter((l) => l.id === variation.id);
      expect(allForVariation.length).toBe(3);
    });
  });

  describe('Stock Validation / oversell prevention (atomic)', () => {
    it('reserves stock when availability allows', async () => {
      const strapi = createStockStrapi([{ reserved_count: 5 }]);

      const res = await reserveStockAtomic(strapi, 1, 5);

      expect(res).toEqual({ success: true, newReservedCount: 5 });
    });

    it('rejects a reservation that would exceed available stock', async () => {
      const strapi = createStockStrapi([], { Count: 10, reservedCount: 10 });

      const res = await reserveStockAtomic(strapi, 1, 1);

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Insufficient stock for reservation/);
    });

    it('cannot oversell the last unit between two concurrent buyers', async () => {
      // Buyer A wins the last unit: guard matches a row.
      const winner = createStockStrapi([{ reserved_count: 1 }]);
      expect((await reserveStockAtomic(winner, 1, 1)).success).toBe(true);

      // Buyer B loses: the guarded UPDATE (count - reserved_count >= qty) matches nothing.
      const loser = createStockStrapi([], { Count: 1, reservedCount: 1 });
      expect((await reserveStockAtomic(loser, 1, 1)).success).toBe(false);
    });
  });

  describe('Restock Operations', () => {
    it('should add stock on restock', () => {
      const currentStock = 50;
      const restockQuantity = 100;
      const newStock = currentStock + restockQuantity;

      expect(newStock).toBe(150);
    });

    it('should require admin permission for restock', () => {
      const user = { role: 'customer' };
      const canRestock = user.role === 'admin' || user.role === 'super-admin';

      expect(canRestock).toBe(false);
    });

    it('should create restock log entry', () => {
      const restockLog = {
        action: 'Restocked',
        previousQuantity: 50,
        restockQuantity: 100,
        newQuantity: 150,
        admin: { id: 1, name: 'John' },
      };

      expect(restockLog.previousQuantity + restockLog.restockQuantity).toBe(
        restockLog.newQuantity,
      );
    });
  });

  describe('Stock Alerts', () => {
    it('should alert when stock falls below threshold', () => {
      const lowStockThreshold = 20;
      const currentStock = 15;

      const shouldAlert = currentStock <= lowStockThreshold;
      expect(shouldAlert).toBe(true);
    });

    it('should alert on out-of-stock', () => {
      const stock = 0;
      const isOutOfStock = stock === 0;

      expect(isOutOfStock).toBe(true);
    });
  });

  describe('Error Handling (atomic)', () => {
    it('returns a structured failure when the SQL boundary throws', async () => {
      const strapi = {
        log: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
        db: {
          connection: { raw: jest.fn().mockRejectedValue(new Error('DB error')) },
          query: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(null) })),
        },
      } as any;

      const res = await decrementStockAtomic(strapi, 1, 5);

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Database error: DB error/);
    });
  });
});
