"use strict";

const getProductVariations = (product = {}) => {
  if (Array.isArray(product.variations) && product.variations.length > 0) {
    return product.variations;
  }

  const stock = Number(product.stock || 0);
  const price = Number(product.price);
  if (!Number.isFinite(stock) || stock < 0 || !Number.isFinite(price) || price < 0) {
    return [];
  }

  return [
    {
      id: "legacy-default",
      name: product.unit || "Standard",
      price,
      stock,
      unit: product.unit || "unit",
      status: stock > 0 ? "Available" : "Out of Stock",
    },
  ];
};

const resolveProductVariation = (product, variationId) => {
  const variations = getProductVariations(product);
  const id = String(variationId || "").trim();
  const variation = variations.find((entry) => entry.id === id);
  return variation ? { variation, variations } : null;
};

const resolveLegacyVariation = (product, variationId) => {
  const variations = getProductVariations(product);
  if (variationId) return resolveProductVariation(product, variationId);
  if (variations.length === 1) return { variation: variations[0], variations };
  return null;
};

module.exports = {
  getProductVariations,
  resolveLegacyVariation,
  resolveProductVariation,
};
