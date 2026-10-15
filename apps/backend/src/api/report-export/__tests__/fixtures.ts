export const joins: any = {
  oiToOrder: "JOIN order_items_order_links l_o ON l_o.order_item_id = oi.id JOIN orders o ON o.id = l_o.order_id",
  oiToVariation: { join: "LEFT JOIN order_items_product_variation_links l_pv ON l_pv.order_item_id = oi.id LEFT JOIN product_variations pv ON pv.id = l_pv.product_variation_id", idExpr: "pv.id" },
  orderToContract: "JOIN orders_contract_links l_c ON l_c.order_id = o.id JOIN contracts c ON c.id = l_c.contract_id",
  contractToTx: "JOIN contract_transactions_contract_links l_ct ON l_ct.contract_id = c.id JOIN contract_transactions ct ON ct.id = l_ct.contract_transaction_id",
  orderToUser: "LEFT JOIN orders_user_links l_u ON l_u.order_id = o.id LEFT JOIN users u ON u.id = l_u.user_id",
  userToInfo: "LEFT JOIN local_user_infos_user_links l_ui ON l_ui.user_id = u.id LEFT JOIN local_user_infos ui ON ui.id = l_ui.local_user_info_id",
  variationToProduct: "JOIN product_variations_product_links l_p ON l_p.product_variation_id = pv.id JOIN products p ON p.id = l_p.product_id",
  variationToStock: "LEFT JOIN product_variations_product_stock_links l_ps ON l_ps.product_variation_id = pv.id LEFT JOIN product_stocks ps ON ps.id = l_ps.product_stock_id",
  variationToColor: { join: "", titleExpr: "NULL::text" }, variationToSize: { join: "", titleExpr: "NULL::text" }, variationToModel: { join: "", titleExpr: "NULL::text" }, txSettlementGateway: true,
};
