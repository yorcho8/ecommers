// src/pages/api/catalogo/pdf.js
import { createClient } from "@libsql/client";
import "dotenv/config";
import puppeteer from "puppeteer";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN,
});

const i18n = {
  es: {
    title: "CATÁLOGO", subtitle: "NEXUS · Colección completa",
    category: "CATEGORÍA", products: "PRODUCTOS", product: "PRODUCTO",
    stock: "Disponible", noStock: "Agotado", available: "unidades",
    toc: "ÍNDICE", generatedOn: "Generado el", contact: "nexus.com",
    tagline: "Calidad y confianza en cada producto",
    sku: "REF", edition: "Edición Digital",
    thanks: "Gracias por su confianza", allRights: "Todos los derechos reservados",
    explore: "Explorar colección", viewMore: "Ver más en",
  },
};

export async function GET({ url }) {
  const lang  = "es";
  const t     = i18n[lang];
  const year  = new Date().getFullYear();
  const fecha = new Date().toLocaleDateString("es-MX", {
    year: "numeric", month: "long", day: "numeric",
  });

  const [catRes, prodRes] = await Promise.all([
    db.execute(`SELECT Id_Categoria, Nombre, Descripcion, Imagen_URL FROM Categoria ORDER BY Nombre ASC`),
    db.execute(`
      SELECT p.Id_Producto, p.Nombre, p.Descripcion, p.Precio, p.StockDisponible,
             pc.Id_Categoria,
             (SELECT ip.Url FROM Imagen_Producto ip WHERE ip.Id_Producto = p.Id_Producto
              ORDER BY ip.Id_Imagen ASC LIMIT 1) AS ImagenUrl
      FROM Producto p
      LEFT JOIN ProductoCategoria pc ON pc.Id_Producto = p.Id_Producto
      WHERE p.Activo = 1
      ORDER BY pc.Id_Categoria, p.Nombre ASC
    `),
  ]);

  const categorias = catRes.rows;
  const productos  = prodRes.rows;
  const porCat = {};
  for (const p of productos) {
    const k = String(p.Id_Categoria ?? "otros");
    (porCat[k] = porCat[k] || []).push(p);
  }

  const html = buildHTML(categorias, porCat, t, lang, year, fecha);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0", timeout: 45000 });
  const pdfBuffer = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    preferCSSPageSize: true,
  });
  await browser.close();

  return new Response(pdfBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment; filename=\"catalogo-nexus-es.pdf\"",
      "Content-Length": String(pdfBuffer.length),
      "Cache-Control": "no-store",
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
function buildHTML(categorias, porCat, t, lang, year, fecha) {
  const totalProds = Object.values(porCat).flat().length;

  const fmtPrice = (p) => p != null
    ? `$${Number(p).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`
    : "—";

  const stockHTML = (prod) => {
    const n = prod.StockDisponible != null ? Number(prod.StockDisponible) : null;
    const ok = n === null || n > 0;
    const txt = n != null ? `${n} ${t.available}` : (ok ? t.stock : t.noStock);
    return `<span class="stock ${ok ? "ok" : "out"}">${txt}</span>`;
  };

  // ── Categoría + Producto pages ──────────────────────────────────────
  let pages = "";

  for (const [ci, cat] of categorias.entries()) {
    const cid   = String(cat.Id_Categoria);
    const prods = porCat[cid] || [];
    const num   = String(ci + 1).padStart(2, "0");

    // ── Divisor de categoría ──
    pages += `
    <section class="pg cat-divider">
      <div class="cat-bg">
        ${cat.Imagen_URL ? `<img src="${cat.Imagen_URL}" alt="" />` : ""}
        <div class="cat-overlay"></div>
      </div>
      <div class="cat-stripe"></div>
      <div class="cat-number">${num}</div>
      <div class="cat-content">
        <div class="cat-eyebrow">${t.category} ${num}</div>
        <div class="cat-line"></div>
        <h2 class="cat-name">${esc(cat.Nombre?.toUpperCase() || "")}</h2>
        ${cat.Descripcion ? `<p class="cat-desc">${esc(cat.Descripcion)}</p>` : ""}
        <div class="cat-meta">
          <span class="cat-count">${prods.length} ${t.products.toLowerCase()}</span>
          <span class="cat-dot">·</span>
          <span class="cat-site">${t.contact}</span>
        </div>
      </div>
      <div class="cat-bottom-line"></div>
    </section>
    `;

    // ── 1 PÁGINA POR PRODUCTO ──
    for (const [pi, prod] of prods.entries()) {
      const sku = `${t.sku} ${String(prod.Id_Producto).padStart(4, "0")}`;
      const price = fmtPrice(prod.Precio);
      const desc = String(prod.Descripcion || "").slice(0, 350);
      const prodNum = String(pi + 1).padStart(2, "0");

      pages += `
      <section class="pg product-page">
        <!-- Hero image -->
        <div class="hero-img">
          ${prod.ImagenUrl
            ? `<img src="${prod.ImagenUrl}" alt="${esc(prod.Nombre)}" />`
            : `<div class="hero-placeholder"><div class="ph-ring"></div><span>${esc((prod.Nombre || "?").charAt(0))}</span></div>`
          }
          <div class="hero-vignette"></div>
          <!-- Floating SKU -->
          <div class="hero-sku">${sku}</div>
          <!-- Floating category -->
          <div class="hero-cat">${esc(cat.Nombre?.toUpperCase() || "")}</div>
        </div>

        <!-- Product info bar -->
        <div class="info-bar">
          <div class="info-left">
            <div class="info-top-row">
              <span class="info-number">${num}.${prodNum}</span>
              <div class="info-name-wrap">
                <h3 class="info-name">${esc(prod.Nombre || "")}</h3>
                <p class="info-desc">${esc(desc)}${desc.length >= 350 ? "…" : ""}</p>
              </div>
            </div>
          </div>
          <div class="info-right">
            <div class="price-block">
              <span class="price-label">MXN</span>
              <span class="price-value">${price}</span>
            </div>
            <div class="stock-block">
              ${stockHTML(prod)}
            </div>
          </div>
        </div>

        <!-- Bottom bar -->
        <div class="page-bottom">
          <span class="bottom-brand">GO</span>
          <span class="bottom-sep"></span>
          <span class="bottom-cat">${esc(cat.Nombre || "")}</span>
          <span class="bottom-spacer"></span>
          <span class="bottom-page">${t.contact}</span>
        </div>
      </section>
      `;
    }
  }

  // ── TOC entries ──
  const tocItems = categorias.map((cat, i) => {
    const cid = String(cat.Id_Categoria);
    const count = (porCat[cid] || []).length;
    const num = String(i + 1).padStart(2, "0");
    return `
      <div class="toc-row">
        <div class="toc-img">
          ${cat.Imagen_URL
            ? `<img src="${cat.Imagen_URL}" alt="" />`
            : `<div class="toc-img-ph">${esc((cat.Nombre || "?").charAt(0))}</div>`}
        </div>
        <span class="toc-num">${num}</span>
        <div class="toc-info">
          <span class="toc-title">${esc(cat.Nombre || "")}</span>
          ${cat.Descripcion ? `<span class="toc-sub">${esc(String(cat.Descripcion).slice(0, 70))}</span>` : ""}
        </div>
        <div class="toc-badge">${count}</div>
      </div>
    `;
  }).join("");

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<style>
/* ════════════════════════════════════════════════════════════════
   LUXURY DARK LOOKBOOK — NEXUS
   ════════════════════════════════════════════════════════════════ */
@page { size: A4; margin: 0; }

*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --o: #F97316;
  --o2: #EA580C;
  --o3: #FB923C;
  --o4: #FFF7ED;
  --bk: #000000;
  --bk2: #0A0A0A;
  --bk3: #141414;
  --bk4: #1C1C1C;
  --bk5: #262626;
  --w: #FFFFFF;
  --w2: #F5F5F5;
  --w3: #E5E5E5;
  --g1: #A3A3A3;
  --g2: #737373;
  --g3: #525252;
  --g4: #404040;
  --gn: #22C55E;
  --gnb: rgba(34,197,94,0.12);
  --rd: #EF4444;
  --rdb: rgba(239,68,68,0.12);
}

body {
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  background: var(--bk);
  color: var(--w);
}

.pg {
  width: 210mm;
  height: 297mm;
  position: relative;
  overflow: hidden;
  page-break-after: always;
  background: var(--bk);
}

img { display: block; width: 100%; height: 100%; object-fit: cover; }

/* ════════════ PORTADA ════════════ */
.cover {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.cover-bg {
  position: absolute; inset: 0;
}

.cover-bg img { width: 100%; height: 100%; object-fit: cover; }

.cover-bg .cover-dark {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at center, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.88) 100%);
}

.cover-bg .no-img {
  width: 100%; height: 100%;
  background: radial-gradient(circle at 30% 40%, var(--bk3) 0%, var(--bk) 70%);
}

.cover-content {
  position: relative; z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.cover-year {
  font-size: 11px;
  color: var(--g2);
  letter-spacing: 8px;
  margin-bottom: 32px;
}

.cover-logo {
  font-size: 100px;
  font-weight: 900;
  color: var(--w);
  letter-spacing: 8px;
  line-height: 1;
  margin-bottom: 6px;
}

.cover-line {
  width: 60px; height: 2px;
  background: var(--o);
  margin: 20px auto;
}

.cover-company {
  font-size: 13px;
  font-weight: 600;
  color: var(--w3);
  letter-spacing: 10px;
  margin-bottom: 32px;
}

.cover-title-main {
  font-size: 44px;
  font-weight: 800;
  letter-spacing: 12px;
  color: var(--w);
  line-height: 1;
  margin-bottom: 8px;
}

.cover-title-sub {
  font-size: 44px;
  font-weight: 800;
  letter-spacing: 12px;
  color: var(--o);
  line-height: 1;
  margin-bottom: 28px;
}

.cover-tagline {
  font-size: 10px;
  font-style: italic;
  color: var(--g2);
  letter-spacing: 1px;
  margin-bottom: 40px;
}

.cover-stats {
  display: flex;
  gap: 50px;
  margin-bottom: 40px;
}

.cover-stat {
  text-align: center;
}

.cover-stat b {
  display: block;
  font-size: 38px;
  font-weight: 800;
  color: var(--o);
  line-height: 1;
}

.cover-stat small {
  font-size: 7px;
  color: var(--g2);
  letter-spacing: 3px;
  text-transform: uppercase;
}

.cover-sep {
  width: 240px; height: 0.5px;
  background: var(--g4);
  margin-bottom: 20px;
}

.cover-contact {
  font-size: 10px;
  font-weight: 600;
  color: var(--o);
  letter-spacing: 2px;
  margin-bottom: 6px;
}

.cover-date {
  font-size: 7.5px;
  color: var(--g3);
}

/* Esquinas decorativas */
.corner { position: absolute; width: 40px; height: 40px; z-index: 3; }
.corner::before, .corner::after {
  content: ''; position: absolute; background: var(--o);
}
.corner-tl { top: 24px; left: 24px; }
.corner-tl::before { top: 0; left: 0; width: 20px; height: 1px; }
.corner-tl::after  { top: 0; left: 0; width: 1px; height: 20px; }
.corner-tr { top: 24px; right: 24px; }
.corner-tr::before { top: 0; right: 0; width: 20px; height: 1px; }
.corner-tr::after  { top: 0; right: 0; width: 1px; height: 20px; }
.corner-bl { bottom: 24px; left: 24px; }
.corner-bl::before { bottom: 0; left: 0; width: 20px; height: 1px; }
.corner-bl::after  { bottom: 0; left: 0; width: 1px; height: 20px; }
.corner-br { bottom: 24px; right: 24px; }
.corner-br::before { bottom: 0; right: 0; width: 20px; height: 1px; }
.corner-br::after  { bottom: 0; right: 0; width: 1px; height: 20px; }

/* ════════════ TOC ════════════ */
.toc-page {
  padding: 0;
  display: flex;
  flex-direction: column;
}

.toc-head {
  padding: 36px 40px 24px;
  border-bottom: 1px solid var(--bk5);
}

.toc-head-top {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 4px;
}

.toc-head-logo {
  font-size: 18px;
  font-weight: 900;
  color: var(--o);
}

.toc-head-sep {
  width: 1px; height: 28px;
  background: var(--g4);
}

.toc-head h2 {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 8px;
  color: var(--w);
}

.toc-head-sub {
  font-size: 9px;
  color: var(--g2);
  margin-left: 60px;
  letter-spacing: 0.5px;
}

.toc-list {
  flex: 1;
  padding: 12px 40px;
}

.toc-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--bk4);
}

.toc-img {
  width: 52px; height: 52px;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  border: 1px solid var(--bk5);
}

.toc-img-ph {
  width: 100%; height: 100%;
  background: var(--bk3);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 700;
  color: var(--g3);
}

.toc-num {
  font-size: 12px;
  font-weight: 700;
  color: var(--o);
  flex-shrink: 0;
  width: 24px;
}

.toc-info { flex: 1; }

.toc-title {
  display: block;
  font-size: 13px;
  font-weight: 700;
  color: var(--w);
  margin-bottom: 3px;
}

.toc-sub {
  display: block;
  font-size: 7.5px;
  color: var(--g2);
  line-height: 1.4;
}

.toc-badge {
  width: 40px; height: 40px;
  border-radius: 50%;
  border: 1.5px solid var(--o);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 800;
  color: var(--o);
  flex-shrink: 0;
}

/* ════════════ CATEGORY DIVIDER ════════════ */
.cat-divider {
  display: flex;
  align-items: flex-end;
}

.cat-bg {
  position: absolute; inset: 0;
}

.cat-bg img { width: 100%; height: 100%; object-fit: cover; }

.cat-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(
    to top,
    rgba(0,0,0,0.95) 0%,
    rgba(0,0,0,0.7) 35%,
    rgba(0,0,0,0.3) 65%,
    rgba(0,0,0,0.15) 100%
  );
}

.cat-stripe {
  position: absolute;
  left: 0; top: 0;
  width: 4px; height: 100%;
  background: var(--o);
  z-index: 5;
}

.cat-number {
  position: absolute;
  right: 30px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 280px;
  font-weight: 900;
  color: var(--w);
  opacity: 0.03;
  line-height: 1;
  z-index: 1;
}

.cat-content {
  position: relative;
  z-index: 5;
  padding: 0 40px 60px;
  width: 65%;
}

.cat-eyebrow {
  font-size: 8px;
  color: var(--o);
  letter-spacing: 5px;
  text-transform: uppercase;
  margin-bottom: 10px;
}

.cat-line {
  width: 40px; height: 2px;
  background: var(--o);
  margin-bottom: 16px;
}

.cat-name {
  font-size: 48px;
  font-weight: 900;
  color: var(--w);
  letter-spacing: 2px;
  line-height: 1;
  margin-bottom: 16px;
}

.cat-desc {
  font-size: 11px;
  color: var(--g1);
  line-height: 1.7;
  margin-bottom: 20px;
}

.cat-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 8px;
  color: var(--g2);
  letter-spacing: 1px;
}

.cat-count {
  background: var(--o);
  color: var(--w);
  padding: 4px 14px;
  border-radius: 20px;
  font-weight: 700;
  font-size: 7.5px;
  letter-spacing: 0.8px;
}

.cat-dot { color: var(--g4); }
.cat-site { color: var(--g3); }

.cat-bottom-line {
  position: absolute;
  bottom: 30px; left: 40px; right: 40px;
  height: 0.5px;
  background: var(--g4);
  z-index: 5;
}

/* ════════════ PRODUCT PAGE (1 per page!) ════════════ */
.product-page {
  display: flex;
  flex-direction: column;
}

.hero-img {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: var(--bk2);
  min-height: 0;
}

.hero-img img {
  width: 100%; height: 100%; object-fit: cover;
}

.hero-vignette {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.25) 100%),
    linear-gradient(to bottom, transparent 70%, rgba(0,0,0,0.4) 100%);
  pointer-events: none;
}

.hero-placeholder {
  width: 100%; height: 100%;
  background: radial-gradient(circle at 50% 45%, var(--bk3) 0%, var(--bk) 80%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.ph-ring {
  width: 60px; height: 60px;
  border: 2px solid var(--bk5);
  border-radius: 50%;
}

.hero-placeholder span {
  font-size: 32px;
  font-weight: 800;
  color: var(--g4);
}

.hero-sku {
  position: absolute;
  top: 16px; left: 16px;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: var(--g1);
  font-size: 8px;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: 5px;
  letter-spacing: 1.5px;
  border: 0.5px solid rgba(255,255,255,0.06);
}

.hero-cat {
  position: absolute;
  top: 16px; right: 16px;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: var(--o);
  font-size: 8px;
  font-weight: 700;
  padding: 6px 16px;
  border-radius: 5px;
  letter-spacing: 2px;
  border: 0.5px solid rgba(249,115,22,0.15);
}

/* ── Info bar ── */
.info-bar {
  flex-shrink: 0;
  height: 165px;
  background: var(--bk);
  border-top: 1.5px solid var(--o);
  display: flex;
  padding: 0 32px;
}

.info-left {
  flex: 1;
  display: flex;
  align-items: flex-start;
  padding-top: 14px;
  padding-right: 24px;
  border-right: 0.5px solid var(--bk5);
}

.info-top-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.info-number {
  font-size: 13px;
  font-weight: 700;
  color: var(--o);
  flex-shrink: 0;
  margin-top: 3px;
  letter-spacing: 0.5px;
}

.info-name-wrap { flex: 1; }

.info-name {
  font-size: 17px;
  font-weight: 800;
  color: var(--w);
  letter-spacing: 0.5px;
  margin-bottom: 8px;
  line-height: 1.25;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.info-desc {
  font-size: 9px;
  color: var(--g1);
  line-height: 1.65;
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.info-right {
  flex-shrink: 0;
  width: 170px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  gap: 12px;
  padding-left: 24px;
}

.price-block {
  text-align: right;
}

.price-label {
  display: block;
  font-size: 8px;
  color: var(--g3);
  letter-spacing: 3px;
  margin-bottom: 3px;
}

.price-value {
  font-size: 28px;
  font-weight: 900;
  color: var(--w);
  letter-spacing: 0.5px;
}

.stock-block {
  text-align: right;
}

.stock {
  font-size: 8px;
  font-weight: 700;
  padding: 5px 16px;
  border-radius: 20px;
  letter-spacing: 0.5px;
}

.stock.ok {
  background: var(--gnb);
  color: var(--gn);
  border: 0.5px solid rgba(34,197,94,0.2);
}

.stock.out {
  background: var(--rdb);
  color: var(--rd);
  border: 0.5px solid rgba(239,68,68,0.2);
}

/* ── Bottom bar ── */
.page-bottom {
  flex-shrink: 0;
  height: 28px;
  background: var(--bk2);
  display: flex;
  align-items: center;
  padding: 0 32px;
  gap: 10px;
}

.bottom-brand {
  font-size: 10px;
  font-weight: 900;
  color: var(--o);
}

.bottom-sep {
  width: 0.5px;
  height: 12px;
  background: var(--g4);
}

.bottom-cat {
  font-size: 7px;
  color: var(--g3);
  letter-spacing: 1px;
}

.bottom-spacer { flex: 1; }

.bottom-page {
  font-size: 7px;
  color: var(--g3);
}

/* ════════════ BACK COVER ════════════ */
.back {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  background: var(--bk);
}

.back-content {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.back-glow {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: 400px; height: 400px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(249,115,22,0.06) 0%, transparent 70%);
  z-index: 1;
}

.back-logo {
  font-size: 88px;
  font-weight: 900;
  color: var(--w);
  letter-spacing: 6px;
  margin-bottom: 8px;
}

.back-line {
  width: 50px; height: 2px;
  background: var(--o);
  margin: 16px auto;
}

.back-company {
  font-size: 14px;
  font-weight: 600;
  color: var(--w3);
  letter-spacing: 10px;
  margin-bottom: 20px;
}

.back-tagline {
  font-size: 10px;
  font-style: italic;
  color: var(--g2);
  margin-bottom: 32px;
}

.back-thanks {
  font-size: 8px;
  font-weight: 700;
  color: var(--o);
  letter-spacing: 4px;
  text-transform: uppercase;
  margin-bottom: 32px;
}

.back-sep2 {
  width: 200px; height: 0.5px;
  background: var(--g4);
  margin-bottom: 16px;
}

.back-contact {
  font-size: 10px;
  font-weight: 700;
  color: var(--o);
  letter-spacing: 2px;
  margin-bottom: 6px;
}

.back-date {
  font-size: 7.5px;
  color: var(--g3);
  margin-bottom: 4px;
}

.back-rights {
  font-size: 6.5px;
  color: var(--g4);
}
</style>
</head>
<body>

<!-- ════════════ PORTADA ════════════ -->
<section class="pg cover">
  <div class="cover-bg">
    ${categorias[0]?.Imagen_URL
      ? `<img src="${categorias[0].Imagen_URL}" alt="" /><div class="cover-dark"></div>`
      : `<div class="no-img"></div>`}
  </div>
  <div class="corner corner-tl"></div>
  <div class="corner corner-tr"></div>
  <div class="corner corner-bl"></div>
  <div class="corner corner-br"></div>
  <div class="cover-content">
    <div class="cover-year">${year}</div>
    <div class="cover-logo">GO</div>
    <div class="cover-line"></div>
    <div class="cover-company">NEXUS</div>
    <div class="cover-title-main">${esc(t.title)}</div>
    <div class="cover-title-sub">${lang === "es" ? "DE PRODUCTOS" : "CATALOG"}</div>
    <div class="cover-tagline">${esc(t.tagline)}</div>
    <div class="cover-stats">
      <div class="cover-stat">
        <b>${categorias.length}</b>
        <small>${esc(t.category)}S</small>
      </div>
      <div class="cover-stat">
        <b>${totalProds}</b>
        <small>${esc(t.products)}</small>
      </div>
    </div>
    <div class="cover-sep"></div>
    <div class="cover-contact">${esc(t.contact)}</div>
    <div class="cover-date">${esc(t.generatedOn)}: ${esc(fecha)}</div>
  </div>
</section>

<!-- ════════════ ÍNDICE ════════════ -->
<section class="pg toc-page">
  <div class="toc-head">
    <div class="toc-head-top">
      <span class="toc-head-logo">GO</span>
      <div class="toc-head-sep"></div>
      <h2>${esc(t.toc)}</h2>
    </div>
    <div class="toc-head-sub">${esc(t.subtitle)}</div>
  </div>
  <div class="toc-list">
    ${tocItems}
  </div>
</section>

<!-- ════════════ CATEGORÍAS + PRODUCTOS ════════════ -->
${pages}

<!-- ════════════ CONTRAPORTADA ════════════ -->
<section class="pg back">
  <div class="back-glow"></div>
  <div class="corner corner-tl"></div>
  <div class="corner corner-tr"></div>
  <div class="corner corner-bl"></div>
  <div class="corner corner-br"></div>
  <div class="back-content">
    <div class="back-logo">GO</div>
    <div class="back-line"></div>
    <div class="back-company">NEXUS</div>
    <p class="back-tagline">${esc(t.tagline)}</p>
    <div class="back-thanks">${esc(t.thanks)}</div>
    <div class="back-sep2"></div>
    <div class="back-contact">${esc(t.contact)}</div>
    <div class="back-date">${esc(t.generatedOn)}: ${esc(fecha)}</div>
    <div class="back-rights">© ${year} NEXUS · ${esc(t.allRights)}</div>
  </div>
</section>

</body>
</html>`;
}

function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}