// Rule-based intent router, shared by the typed box and the voice path. Pure and dependency-free
// so it runs in the browser (served at /intent.js) and under `node --test`.
//
// Voice is what shapes these rules. AssemblyAI returns *formatted* transcripts -- "Details one."
// rather than "details 1" -- so every rule has to survive three things typing never produces:
// leading capitals, a terminal period or question mark, and numbers spelled as words. Before this
// was handled, "details one" reached the server as recall id "one." and "remove item two" matched
// nothing at all, which broke every follow-up in the demo.

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

/** "3" | "three" | "third" | "one." -> 3, else null. */
export function spokenNumber(s) {
  const w = String(s ?? '').toLowerCase().replace(/^[#\s]+|[^a-z0-9]+$/g, '');
  if (/^\d+$/.test(w)) return Number(w);
  return NUMBER_WORDS[w] ?? null;
}

/** Free text -> an item record. "2022 Honda Odyssey, VIN: 1HG..." -> name/brand/model. */
export function parseItem(s) {
  const it = { name: s.replace(/[.?!]+$/, '').trim() };
  const mm = it.name.match(/,?\s*(?:model|vin)\s*[:#]?\s*([\w-]+)$/i);
  if (mm) { it.model = mm[1]; it.name = it.name.slice(0, mm.index).trim(); }
  const w = it.name.split(/\s+/), b = w[/^(19|20)\d\d$/.test(w[0]) ? 1 : 0];
  if (b && /^[A-Z]/.test(b)) it.brand = b;
  return it;
}

// Resolve "1" / "one" / "cpsc:20062" to a recall id, against the last check_recalls results.
const recallRef = (s, lastMatches) => {
  const n = spokenNumber(s);
  if (n === null) return String(s).replace(/[.?!]+$/, '');
  const m = lastMatches[n - 1];
  if (!m) throw new Error(`I don't have a result number ${n} — say "check recalls" first`);
  return m.recall_id;
};

const RULES = [
  [/^(?:alexa,?\s*)?(?:add|i (?:have|own|bought|got)|we (?:have|own|bought|got))\s+(?:an?\s+)?(.+)/i,
    (m) => ['add_item', parseItem(m[1])]],
  [/^(?:alexa,?\s*)?(?:remove|delete|forget)\s+(?:item\s*)?#?(\w+)/i,
    (m) => { const n = spokenNumber(m[1]); if (n === null) throw new Error(`Which item number should I remove?`); return ['remove_item', { id: n }]; }],
  [/what do (?:i|we) (?:own|have)|inventory|list(?: my)? (?:items|stuff)|my (?:items|stuff)/i, () => ['list_items', {}]],
  [/^(?:alexa,?\s*)?import/i, () => ['import', {}]],
  // `the` is optional filler people say out loud ("fix the second one"); skip it so the ordinal
  // is what gets captured, not the article.
  [/^(?:alexa,?\s*)?(?:details?|more|tell me (?:more )?about)\s+(?:the\s+)?(?:recall\s*)?#?(\S+)/i,
    (m, ctx) => ['recall_details', { recall_id: recallRef(m[1], ctx) }]],
  [/^(?:alexa,?\s*)?(?:help me fix|fix|remedy|start (?:the )?remedy|what should i do about)\s+(?:the\s+)?(?:recall\s*)?#?(\S+)/i,
    (m, ctx) => ['start_remedy', { recall_id: recallRef(m[1], ctx) }]],
  [/recall.*?(?:item\s*)?#?\s*(\d+)\b/i, (m) => ['check_recalls', { item_id: +m[1] }]],
  [/recall/i, () => ['check_recalls', {}]],
];

/**
 * @param {string} text  what the user typed or said
 * @param {{recall_id:string}[]} lastMatches  results of the last check_recalls, for "details one"
 * @returns {[string, object]|null}  [toolName, args], or null if nothing matched
 */
export function route(text, lastMatches = []) {
  const t = String(text).trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
  for (const [re, build] of RULES) {
    const m = t.match(re);
    if (m) return build(m, lastMatches);
  }
  return null;
}

export const HELP = 'I can: "add Graco 4Ever car seat", "add 2022 Honda Odyssey", "import my orders", '
  + '"what do I own", "remove item two", "is anything recalled?", "details one", "help me fix one".';
