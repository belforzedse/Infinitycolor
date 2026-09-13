enum OrderStatus {
  Pending = "PENDING",
  Processing = "PROCESSING",
  Shipped = "SHIPPED",
  Delivered = "DELIVERED",
  Cancelled = "CANCELLED",
}

enum PersianOrderStatus {
  INPROGRESS = "در حال انجام",
  // Names the final fulfilment bucket, which is now «ارسال» rather than «تکمیل شده».
  DELIVERED = "ارسال شده",
  CANCELLED = "لغو شده یا ناموفق",
  MANUAL = "سفارش‌های دستی",
}

enum PaymentMethod {
  CreditCard = "CREDIT_CARD",
  BankTransfer = "BANK_TRANSFER",
  Cash = "CASH_ON_DELIVERY",
}

export { OrderStatus, PaymentMethod, PersianOrderStatus };
