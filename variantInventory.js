/* =========================================================
   VARIANT INVENTORY HELPERS (shared by index.js and walletRoutes.js)

   Inventory lives inside products/{id}.variants[]:
     { id, name, unit, price, stock, status, createdAt, updatedAt }
   There are NO batches and NO harvest records anymore.
   One order line = one product variant.
========================================================= */

const roundStock6 = (value) => Number(Number(value).toFixed(6));

// Payment is valid / order is valid, but the variant cannot cover the quantity.
class StockFulfillmentError extends Error {
  constructor(message) {
    super(message);
    this.name = "StockFulfillmentError";
    this.code = "STOCK_UNAVAILABLE";
    this.status = 409;
  }
}

const badRequest = (message) =>
  Object.assign(new Error(message), { status: 400 });

const getProductVariants = (product) =>
  Array.isArray(product?.variants) ? product.variants : [];

/*
  Validates the shape of the order lines (no DB access).
  Duplicate means SAME product AND SAME variant.
  Returns [{ orderProduct, index, productId, variantId, quantity }]
*/
const parseOrderLines = (orderProducts) => {
  if (!Array.isArray(orderProducts) || orderProducts.length === 0) {
    throw badRequest("Order contains no products.");
  }

  const seen = new Set();

  return orderProducts.map((orderProduct, index) => {
    const productId = String(orderProduct?.productId || "").trim();

    if (!productId) {
      throw badRequest("Order contains an invalid productId.");
    }

    const variantId = String(orderProduct?.variantId || "").trim();
    const lineKey = `${productId}|${variantId}`;

    if (seen.has(lineKey)) {
      throw badRequest(`Duplicate product variant in order: ${productId}`);
    }

    seen.add(lineKey);

    const quantity = Number(orderProduct?.quantity);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw badRequest(`Invalid quantity for ${productId}.`);
    }

    return { orderProduct, index, productId, variantId, quantity };
  });
};

/*
  Finds the variant on the SERVER product document.
  - variantId given      -> must exist.
  - variantId missing    -> allowed ONLY when the product has exactly one
                            variant (legacy carts / old orders).
*/
const resolveVariant = (product, variantId) => {
  const variants = getProductVariants(product);
  const productName = product?.name || "this product";

  if (variants.length === 0) {
    throw badRequest(
      `${productName} has no variants. The farmer must update this product first.`
    );
  }

  let variant = null;

  if (variantId) {
    variant = variants.find((item) => String(item.id) === String(variantId));
  } else if (variants.length === 1) {
    variant = variants[0];
  } else {
    throw badRequest(`Please select a variant for ${productName}.`);
  }

  if (!variant) {
    throw badRequest(
      `The selected variant of ${productName} is no longer available.`
    );
  }

  return variant;
};

// Throws StockFulfillmentError when the variant cannot cover `quantity`.
const assertVariantStock = (product, variant, quantity) => {
  const label = `${product?.name || "Product"} (${variant.name})`;
  const stock = Number(variant.stock);

  if (
    variant.status !== "Available" ||
    !Number.isFinite(stock) ||
    stock <= 0
  ) {
    throw new StockFulfillmentError(`${label} is out of stock.`);
  }

  if (stock < quantity) {
    throw new StockFulfillmentError(
      `Insufficient stock for ${label}. Available: ${stock}, Requested: ${quantity}.`
    );
  }
};

// Server price of a variant (client price is never trusted).
const getVariantPrice = (product, variant) => {
  const price = Number(variant.price);

  if (!Number.isFinite(price) || price < 0) {
    throw badRequest(
      `Invalid price for ${product?.name || "product"} (${variant.name}).`
    );
  }

  return price;
};

// Summary fields stored on the product document (cards / listing).
const summarizeVariants = (variants) => {
  const sellable = variants.filter(
    (variant) =>
      variant.status === "Available" && Number(variant.stock) > 0
  );

  const priceSource = sellable.length > 0 ? sellable : variants;

  return {
    price:
      priceSource.length > 0
        ? Math.min(...priceSource.map((variant) => Number(variant.price) || 0))
        : 0,
    stock: roundStock6(
      sellable.reduce((sum, variant) => sum + Number(variant.stock || 0), 0)
    ),
    status: sellable.length > 0 ? "Available" : "Out of Stock",
  };
};

module.exports = {
  roundStock6,
  StockFulfillmentError,
  badRequest,
  getProductVariants,
  parseOrderLines,
  resolveVariant,
  assertVariantStock,
  getVariantPrice,
  summarizeVariants,
};
