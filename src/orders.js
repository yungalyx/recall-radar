// Amazon "Your Orders" CSV → inventory items. Handles both export layouts
// (classic: "Order Date","Title","ASIN/ISBN","Category","Quantity"; privacy export: "Order Date","Product Name","ASIN",...).
import { inferCategory } from './match.js';

/** RFC 4180-ish: quoted fields, doubled quotes, embedded newlines, CRLF. @returns {string[][]} */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

const col = (header, re) => header.findIndex((h) => re.test(h.trim()));
// ponytail: brand = first word of the title when it looks like a proper noun; good enough for Amazon titles ("Graco 4Ever DLX ...").
const guessBrand = (title) => { const w = title.trim().split(/\s+/)[0] || ''; return /^[A-Z][A-Za-z0-9&'.-]{1,}$/.test(w) && !/^(the|new|set|pack|for|kids|baby)$/i.test(w) ? w.replace(/[,.]$/, '') : null; };

/** @returns {{name:string, brand:string|null, category:string, purchased_on:string|null, asin:string|null, quantity:number}[]} */
export function parseOrders(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) return [];
  const h = rows[0];
  const iName = col(h, /^(title|product name)$/i), iAsin = col(h, /^asin/i), iDate = col(h, /^order date$/i), iCat = col(h, /^category$/i), iQty = col(h, /^quantity$/i);
  if (iName < 0) throw new Error('CSV has no "Title" or "Product Name" column');
  const seen = new Set(), out = [];
  for (const r of rows.slice(1)) {
    const name = (r[iName] || '').trim();
    if (!name) continue;
    const asin = iAsin >= 0 ? (r[iAsin] || '').trim() || null : null;
    const key = asin || name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const date = iDate >= 0 ? (r[iDate] || '').trim() : '';
    out.push({
      name, brand: guessBrand(name), asin,
      category: iCat >= 0 && r[iCat]?.trim() ? r[iCat].trim().toLowerCase() : inferCategory(name),
      purchased_on: date ? (Number.isNaN(Date.parse(date)) ? date : new Date(date).toISOString().slice(0, 10)) : null,
      quantity: iQty >= 0 ? Number(r[iQty]) || 1 : 1,
    });
  }
  return out;
}
