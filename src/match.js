// Explainable recall matcher: token normalisation + fuzzy token similarity + weighted brand/model/name hits.
// No LLM in v0; `rerank()` is the hook for an OpenAI-compatible judge (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL).

const STOP = new Set('the a an and or of for with in on to by from at is are this that it its new set piece pieces count ct oz pk inch inches'.split(' '));
const CATEGORY_WORDS = {
  food: /\b(food|snack|cereal|butter|juice|milk|cheese|formula|candy|chocolate|cookie|cookies|sauce|salad|spinach|lettuce|beef|chicken|pork|eggs?|flour|rice|pasta|soup|yogurt|ice cream|fruit|nuts?|granola|coffee|tea|water|beverage|drink|seasoning|spice)\b/i,
  drug: /\b(tablets?|caplets?|capsules?|\d*mg|\d*ml|vitamins?|supplement|medicine|medication|drops|syrup|cough|allergy|pain reliever|ibuprofen|acetaminophen|aspirin|insulin|inhaler|ointment|cream|eye drops|sanitizer|lotion)\b/i,
  device: /\b(cpap|ventilator|infusion pump|glucose|thermometer|pacemaker|catheter|wheelchair|hearing aid|defibrillator|blood pressure|pulse oximeter|nebulizer|medical)\b/i,
};
const VEHICLE_RE = /\b(19[89]\d|20[0-3]\d)\s+[a-z][a-z-]+\s+[a-z0-9-]+/i;

/** @param {string} name @returns {'vehicle'|'food'|'drug'|'device'|'product'} */
export function inferCategory(name) {
  if (VEHICLE_RE.test(name) || /\b(car|truck|suv|minivan|sedan)\b/i.test(name) && !/\bseat\b/i.test(name)) return 'vehicle';
  for (const [cat, re] of Object.entries(CATEGORY_WORDS)) if (re.test(name)) return cat;
  return 'product';
}

/** Lowercase alphanumeric tokens, stopwords and 1-char tokens dropped. */
export function tokens(s) {
  return String(s || '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));
}

const bigrams = (s) => { const b = new Set(); for (let i = 0; i < s.length - 1; i++) b.add(s.slice(i, i + 2)); return b; };
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size || 1);
}
/** Exact, or ≥0.8 Dice-bigram similarity for words of 4+ chars (typos: "odysey" ~ "odyssey"). */
export const similar = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && dice(a, b) >= 0.8);
const hit = (tok, set) => { for (const t of set) if (similar(tok, t)) return t; return null; };

/**
 * Score one item against one normalised recall (see recalls.js for the record shape).
 * @returns {{confidence:number, reason:string, matched:{brand:string[], model:string[], name:string[]}}}
 */
export function scoreMatch(item, recall) {
  const brandT = tokens(item.brand), modelT = tokens(item.model);
  const nameT = tokens(item.name).filter((t) => !brandT.includes(t) && !modelT.includes(t));
  const rBrand = new Set(tokens(recall.brand)), rTitle = new Set(tokens(recall.title));
  const rProducts = new Set(recall.products.flatMap((p) => tokens(p.name)));
  const rModels = new Set(recall.products.flatMap((p) => tokens(p.model)));
  const rDesc = new Set(tokens(recall.description));
  const rTitleProducts = new Set([...rTitle, ...rProducts]);
  const matched = { brand: [], model: [], name: [] }, why = [];
  let score = 0;

  for (const t of brandT) if (hit(t, rBrand) || hit(t, rTitle)) matched.brand.push(t);
  if (matched.brand.length) { score += 0.35; why.push(`brand "${matched.brand.join(' ')}" matches recall`); }
  else if (!brandT.length && nameT[0] && (hit(nameT[0], rBrand))) { score += 0.25; matched.brand.push(nameT[0]); why.push(`"${nameT[0]}" matches recalling company`); }

  for (const t of modelT) if (rModels.has(t) || rDesc.has(t) || rTitle.has(t) || hit(t, rTitleProducts)) matched.model.push(t);
  if (matched.model.length) { score += 0.35; why.push(`model "${matched.model.join(' ')}" named in recall`); }

  let nameScore = 0;
  for (const t of nameT) {
    if (hit(t, rTitleProducts)) { nameScore += 1; matched.name.push(t); }
    else if (hit(t, rDesc)) { nameScore += 0.5; matched.name.push(t); }
  }
  if (nameT.length) {
    score += 0.5 * (nameScore / nameT.length);
    if (matched.name.length) why.push(`${matched.name.length}/${nameT.length} product words match (${matched.name.join(', ')})`);
  }
  if (brandT.length && !matched.brand.length && rBrand.size) { score *= 0.5; why.push(`brand "${item.brand}" not in recall (halved)`); }

  return { confidence: Math.min(1, Math.round(score * 100) / 100), reason: why.join('; ') || 'no overlap', matched };
}

/** Rank recalls for one item; keep those at/above threshold, best first. */
export function rankMatches(item, recalls, threshold = Number(process.env.MATCH_THRESHOLD) || 0.4) {
  return recalls.map((recall) => ({ recall, ...scoreMatch(item, recall) }))
    .filter((m) => m.confidence >= threshold)
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * LLM judge hook (optional). Reranks by asking an OpenAI-compatible chat endpoint for a 0–1 verdict per candidate.
 * No-op unless LLM_BASE_URL is set; any failure falls back to the heuristic scores.
 */
export async function rerank(item, matches) {
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
  if (!LLM_BASE_URL || !matches.length) return matches;
  try {
    const candidates = matches.map((m, i) => ({ i, title: m.recall.title, brand: m.recall.brand, description: m.recall.description.slice(0, 400) }));
    const res = await fetch(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(LLM_API_KEY && { authorization: `Bearer ${LLM_API_KEY}` }) },
      body: JSON.stringify({
        model: LLM_MODEL, temperature: 0, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You judge whether a consumer recall applies to a household item. Reply with JSON {"verdicts":[{"i":<index>,"p":<0-1 probability>,"why":"<short>"}]}.' },
          { role: 'user', content: JSON.stringify({ item: { name: item.name, brand: item.brand, model: item.model, category: item.category }, candidates }) },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const { verdicts } = JSON.parse((await res.json()).choices[0].message.content);
    for (const v of verdicts) if (matches[v.i]) { matches[v.i].confidence = Math.round(v.p * 100) / 100; matches[v.i].reason += `; judge: ${v.why}`; }
    return matches.sort((a, b) => b.confidence - a.confidence);
  } catch (e) {
    console.warn('llm rerank skipped:', e.message);
    return matches;
  }
}
