// Egg half-tray (15 pcs) / full-tray (30 pcs) pricing and stock.
// Matches the mobile productCatalog helpers. Prices come from the
// server product price, stock is deducted in base units.

const EGG_PRODUCT_PREFIXES = ["chicken egg", "duck egg", "quail egg", "itik egg"];

const toCanonicalKey = (name) => {
  if (!name) return null;
  const base = String(name)
    .split("(")[0]
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return base || null;
};

const isEggProduct = (productName) => {
  const key = toCanonicalKey(productName);
  if (key === null) return false;
  return EGG_PRODUCT_PREFIXES.some(
    (prefix) => key === prefix || key.startsWith(prefix + " ")
  );
};

const roundMoney2 = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round((number + Number.EPSILON) * 100) / 100;
};

const roundStock6 = (value) => Number(Number(value).toFixed(6));

const normalizeUnit = (unit) =>
  String(unit || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const isHalfTrayUnit = (unit) => normalizeUnit(unit) === "half tray";

const isFullTrayUnit = (unit) => {
  const u = normalizeUnit(unit);
  return u === "per tray" || u === "tray" || u === "full tray";
};

const isTrayUnit = (unit) => isHalfTrayUnit(unit) || isFullTrayUnit(unit);

const normalizeEggVariant = (value) => {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "half" || v === "half tray" || v === "half-tray") return "half";
  if (v === "full" || v === "per tray" || v === "full tray" || v === "tray")
    return "full";
  return null;
};

const getVariantPrice = (baseUnit, basePrice, variant) => {
  const halfBase = isHalfTrayUnit(baseUnit);
  if (variant === "half") {
    return halfBase ? roundMoney2(basePrice) : roundMoney2(basePrice / 2);
  }
  return halfBase ? roundMoney2(basePrice * 2) : roundMoney2(basePrice);
};

const getVariantUnit = (variant) =>
  variant === "half" ? "half tray" : "per tray";

const variantToBaseQuantity = (variant, variantQty, baseUnit) => {
  const v = normalizeEggVariant(variant);
  const qty = Number(variantQty);
  if (!v || !Number.isFinite(qty)) return Number(variantQty) || 0;
  if (v === "half" && isFullTrayUnit(baseUnit)) return roundStock6(qty / 2);
  if (v === "full" && isHalfTrayUnit(baseUnit)) return roundStock6(qty * 2);
  return qty;
};

// Resolves a client order/cart line against the SERVER product.
// Returns null when the line is NOT a valid egg-variant purchase
// (normal product, or tampered variant on a non-egg listing).
// All price/unit/base math comes from server data — client values
// for price are never trusted.
const resolveEggLine = (serverProduct, orderLine) => {
  const variant = normalizeEggVariant(orderLine?.eggVariant);
  if (!variant) return null;
  if (!serverProduct || !isEggProduct(serverProduct.name)) return null;

  const baseUnit = serverProduct.unit;
  if (!isTrayUnit(baseUnit)) return null;

  const basePrice = Number(serverProduct.price);
  if (!Number.isFinite(basePrice) || basePrice < 0) return null;

  const variantQty = Number(orderLine?.quantity);
  if (!Number.isFinite(variantQty) || variantQty <= 0) return null;

  return {
    variant,
    variantUnit: getVariantUnit(variant),
    variantPrice: getVariantPrice(baseUnit, basePrice, variant),
    variantQty,
    baseUnit,
    basePrice: roundMoney2(basePrice),
    baseQty: variantToBaseQuantity(variant, variantQty, baseUnit),
  };
};

module.exports = {
  EGG_PRODUCT_PREFIXES,
  isEggProduct,
  isHalfTrayUnit,
  isFullTrayUnit,
  isTrayUnit,
  normalizeEggVariant,
  getVariantPrice,
  getVariantUnit,
  variantToBaseQuantity,
  resolveEggLine,
  roundMoney2,
  roundStock6,
};
