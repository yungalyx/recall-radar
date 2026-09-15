// Recall connectors (all public, no key): CPSC SaferProducts, NHTSA recalls + vPIC, openFDA enforcement.
// Every upstream response is cached in SQLite (recall_cache) for CACHE_TTL_HOURS. Records are normalised to one shape:
// { id, source, title, brand, products:[{name, model}], description, hazard, remedy, contact, url, date }

const TTL_MS = (Number(process.env.CACHE_TTL_HOURS) || 24) * 3600e3;
const LOOKBACK_YEARS = Number(process.env.RECALL_LOOKBACK_YEARS) || 3;
const UA = 'recall-radar/0.1 (+https://github.com/yungalyx/recall-radar)';

export function sinceDate() { const d = new Date(); d.setFullYear(d.getFullYear() - LOOKBACK_YEARS); return d.toISOString().slice(0, 10); }
const today = () => new Date().toISOString().slice(0, 10);

// ponytail: CPSC has ~450 recalls/year, so bulk pulls per TTL and local matching beat per-item queries (3 MB, ~1 s).
// In one-year slices: on 2026-09-14 the single 3-year pull started failing server-side ("The underlying provider
// failed on Open") while 1-year windows kept working. Each slice is cached on its own, so one bad year costs one year.
export function cpscUrls() {
  const iso = (d) => d.toISOString().slice(0, 10);
  const urls = [];
  for (let i = 0; i < LOOKBACK_YEARS; i++) {
    const to = new Date(); to.setFullYear(to.getFullYear() - i);
    const from = new Date(); from.setFullYear(from.getFullYear() - i - 1); from.setDate(from.getDate() + 1);
    urls.push(`https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${iso(from)}&RecallDateEnd=${iso(to)}`);
  }
  return urls;
}
// SaferProducts reports its own failures as HTTP 200 with one placeholder row. That is an error, not a recall list.
const isCpscError = (v) => Array.isArray(v) && v.length === 1 && v[0]?.RecallID === 0 && /^Error/i.test(v[0]?.Title || '');
export const nhtsaUrl = (make, model, year) => `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`;
export const vpicUrl = (vin) => `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`;
export function fdaUrl(kind, terms, brand) {
  const q = terms.map((t) => `product_description:${t}`).join('+AND+');
  const firm = brand ? `+OR+recalling_firm:"${encodeURIComponent(brand)}"` : '';
  const range = `recall_initiation_date:[${sinceDate().replace(/-/g, '')}+TO+${today().replace(/-/g, '')}]`;
  const key = process.env.FDA_API_KEY ? `&api_key=${process.env.FDA_API_KEY}` : '';
  return `https://api.fda.gov/${kind}/enforcement.json?search=(${q}${firm})+AND+${range}&limit=25${key}`;
}

const memo = new Map(); // ponytail: in-process parsed copy so the 3 MB CPSC bulk is parsed once per TTL, not per check
/** GET url as JSON through the SQLite TTL cache. 404 from openFDA means "no results" and is cached as null. */
export async function fetchCached(db, url) {
  const m = memo.get(url);
  if (m && Date.now() - m.at < TTL_MS) return m.value;
  const row = db.prepare('select body, fetched_at from recall_cache where url = ?').get(url);
  if (row && Date.now() - row.fetched_at < TTL_MS) { const value = JSON.parse(row.body); memo.set(url, { at: row.fetched_at, value }); return value; }
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (res.status === 404) { db.prepare('insert or replace into recall_cache(url, body, fetched_at) values (?,?,?)').run(url, 'null', Date.now()); return null; }
  if (!res.ok) { if (row) return JSON.parse(row.body); throw new Error(`${res.status} from ${new URL(url).host}`); } // stale-if-error
  const body = await res.text();
  const value = JSON.parse(body); // throw before caching junk
  if (isCpscError(value)) { if (row) return JSON.parse(row.body); throw new Error(`error payload from ${new URL(url).host}`); } // stale-if-error, never cached
  db.prepare('insert or replace into recall_cache(url, body, fetched_at) values (?,?,?)').run(url, body, Date.now());
  memo.set(url, { at: Date.now(), value });
  return value;
}

const names = (arr) => (arr || []).map((x) => x.Name).filter(Boolean);
export function normalizeCpsc(r) {
  const brand = [...names(r.Manufacturers), ...names(r.Importers), ...names(r.Distributors)].map((n) => n.split(/,| of /)[0]).join(' ');
  return {
    id: `cpsc:${r.RecallNumber}`, source: 'cpsc', title: r.Title, brand,
    products: (r.Products || []).map((p) => ({ name: p.Name || '', model: p.Model || '' })),
    description: r.Description || '', hazard: names(r.Hazards).join(' '), remedy: names(r.Remedies).join(' '),
    contact: r.ConsumerContact || '', url: r.URL, date: (r.RecallDate || '').slice(0, 10),
    image: r.Images?.[0]?.URL || null,
  };
}
export function normalizeNhtsa(r) {
  const [d, m, y] = (r.ReportReceivedDate || '').split('/');
  return {
    id: `nhtsa:${r.NHTSACampaignNumber}`, source: 'nhtsa', title: `${r.ModelYear} ${r.Make} ${r.Model}: ${r.Component}`, brand: r.Make,
    products: [{ name: `${r.ModelYear} ${r.Make} ${r.Model}`, model: r.Model }],
    description: r.Summary || '', hazard: r.Consequence || '', remedy: r.Remedy || '',
    contact: [r.Remedy?.match(/contact [^.]+\./i)?.[0], r.Notes].filter(Boolean).join(' '),
    url: `https://www.nhtsa.gov/recalls?nhtsaId=${r.NHTSACampaignNumber}`, date: y ? `${y}-${m}-${d}` : '', image: null,
  };
}
export function normalizeFda(r) {
  const d = r.recall_initiation_date || '';
  return {
    id: `fda:${r.recall_number}`, source: 'fda', title: `${r.classification} ${r.product_type} recall: ${r.product_description.slice(0, 120)}`,
    brand: r.recalling_firm || '', products: [{ name: r.product_description, model: '' }],
    description: `${r.product_description} ${r.code_info || ''}`.trim(), hazard: r.reason_for_recall || '',
    remedy: `Status: ${r.status}. ${r.product_type === 'Food' ? 'Do not consume it; return it for a refund or discard it.' : 'Stop using it and follow the recalling firm’s instructions.'}`,
    contact: `${r.recalling_firm}, ${r.city}, ${r.state}`, url: `https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event=${r.event_id}`,
    date: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '', image: null,
  };
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
/** Extract {year, make, model} from an item ("2022 Honda Odyssey" or brand/model fields, or a VIN via vPIC). */
export async function parseVehicle(db, item) {
  if (item.model && VIN_RE.test(item.model)) {
    const v = (await fetchCached(db, vpicUrl(item.model)))?.Results?.[0];
    if (v?.Make && v?.Model && v?.ModelYear) return { year: v.ModelYear, make: v.Make, model: v.Model };
  }
  const words = `${item.brand || ''} ${item.model || ''} ${item.name}`.split(/\s+/).filter(Boolean);
  const year = words.find((w) => /^(19[89]\d|20[0-3]\d)$/.test(w));
  const rest = words.filter((w) => w !== year);
  const make = item.brand || rest[0], model = item.model || rest.find((w) => w.toLowerCase() !== make?.toLowerCase());
  return year && make && model ? { year, make, model } : null;
}

const fdaTerms = (item) => [...new Set(String(item.name).toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 2 && !/^(the|and|with|for|pack|count)$/.test(t)))].slice(0, 4);

/** All candidate recalls for an item, routed by category. Never throws on a single upstream failure. */
export async function candidatesFor(db, item) {
  const cat = item.category || 'product';
  const guard = (p) => p.catch((e) => { console.warn(`recall source failed for "${item.name}": ${e.message}`); return []; });
  const jobs = [];
  if (cat === 'vehicle') {
    jobs.push(guard(parseVehicle(db, item).then(async (v) => v ? ((await fetchCached(db, nhtsaUrl(v.make, v.model, v.year)))?.results || []).map(normalizeNhtsa) : [])));
  } else {
    for (const u of cpscUrls()) jobs.push(guard(fetchCached(db, u).then((rows) => (rows || []).map(normalizeCpsc))));
    const kinds = { food: ['food'], drug: ['drug'], device: ['device'] }[cat] || [];
    for (const kind of kinds) jobs.push(guard(fetchCached(db, fdaUrl(kind, fdaTerms(item), item.brand)).then((j) => (j?.results || []).map(normalizeFda))));
  }
  return (await Promise.all(jobs)).flat();
}

/** Step-by-step remedy for a normalised recall. */
export function remedySteps(recall) {
  const r = recall.remedy.toLowerCase();
  const path = /refund/.test(r) ? 'refund' : /replace/.test(r) ? 'replacement' : /repair|dealer|free of charge/.test(r) ? 'free repair' : /dispose|discard|destroy/.test(r) ? 'dispose' : 'follow instructions';
  const remindOn = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
  const phone = recall.contact.match(/\d{3}[-.\s]\d{3}[-.\s]\d{4}|1-?8\d\d[-.\s]\d{3}[-.\s]\d{4}/)?.[0] || null;
  const web = recall.contact.match(/https?:\/\/\S+|www\.\S+/)?.[0]?.replace(/[.,]$/, '') || recall.url;
  const steps = [
    { step: 1, title: 'Stop using it now', detail: recall.hazard || 'A safety hazard was reported.' },
    { step: 2, title: 'Confirm your unit is affected', detail: recall.source === 'nhtsa' ? `Check your VIN at ${recall.url}` : recall.description.slice(0, 400) },
    { step: 3, title: `Contact ${recall.brand || 'the company'}`, detail: recall.contact || `See ${recall.url}` },
    { step: 4, title: `Get your ${path}`, detail: recall.remedy || 'Follow the instructions on the recall page.' },
    { step: 5, title: 'Set a reminder', detail: `Follow up on ${remindOn} if you have not heard back.` },
  ];
  return { recall_id: recall.id, title: recall.title, path, phone, web, steps, reminder: { on: remindOn, text: `Check status of ${recall.title.slice(0, 60)} ${path}` } };
}
