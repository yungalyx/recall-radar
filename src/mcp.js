// MCP server: tools + household://inventory resource, bound to one user (OAuth subject) per instance.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseOrders } from './orders.js';
import { inferCategory, rankMatches, rerank } from './match.js';
import { candidatesFor, remedySteps } from './recalls.js';

const ok = (text, data) => ({ content: [{ type: 'text', text }], structuredContent: data });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
const level = (c) => (c >= 0.75 ? 'high' : c >= 0.5 ? 'medium' : 'low');

export function createMcpServer(db, sub) {
  const items = () => db.prepare('select * from items where user_id = ? order by id').all(sub);
  const item = (id) => db.prepare('select * from items where user_id = ? and id = ?').get(sub, id);
  const recall = (id) => { const r = db.prepare('select json from recalls where id = ?').get(id); return r ? JSON.parse(r.json) : null; };
  const insertItem = db.prepare('insert into items(user_id, name, brand, model, category, purchased_on, asin) values (?,?,?,?,?,?,?)');
  const addItem = (a) => insertItem.run(sub, a.name.trim(), a.brand || null, a.model || null, a.category || inferCategory(a.name), a.purchased_on || null, a.asin || null).lastInsertRowid;

  const server = new McpServer({ name: 'recall-radar', version: '0.1.0' }, {
    instructions: 'Recall Radar keeps a household inventory and checks it against CPSC, NHTSA and FDA recalls. Typical flow: add_item or import_orders → check_recalls → recall_details → start_remedy.',
  });

  server.registerTool('add_item', {
    title: 'Add an item to the household inventory',
    description: 'Add something the household owns. Give brand and model when known — they make recall matching much more precise. Vehicles: name like "2022 Honda Odyssey" (or put the VIN in model).',
    inputSchema: {
      name: z.string().min(1).describe('What it is, e.g. "Graco 4Ever car seat" or "2022 Honda Odyssey"'),
      brand: z.string().optional(), model: z.string().optional().describe('Model number/name, or a 17-char VIN for vehicles'),
      category: z.enum(['product', 'vehicle', 'food', 'drug', 'device']).optional().describe('Inferred from the name when omitted'),
      purchased_on: z.string().optional().describe('ISO date'),
    },
  }, async (a) => {
    const id = addItem(a);
    const it = item(id);
    return ok(`Added #${id}: ${it.name}${it.brand ? ` (${it.brand})` : ''} [${it.category}]`, { item: it });
  });

  server.registerTool('list_items', { title: 'List the household inventory', description: 'Everything the household has registered, with ids.', inputSchema: {} },
    async () => { const all = items(); return ok(all.length ? all.map((i) => `#${i.id} ${i.name}${i.brand ? ` (${i.brand})` : ''} [${i.category}]`).join('\n') : 'Inventory is empty.', { items: all }); });

  server.registerTool('remove_item', { title: 'Remove an item', description: 'Remove an item by id.', inputSchema: { id: z.number().int() } },
    async ({ id }) => {
      const it = item(id);
      if (!it) return fail(`No item #${id}`);
      db.prepare('delete from items where id = ?').run(id);
      db.prepare('delete from matches where item_id = ?').run(id);
      return ok(`Removed #${id} ${it.name}`, { removed: it });
    });

  server.registerTool('import_orders', {
    title: 'Import an Amazon "Your Orders" CSV',
    description: 'Paste the CSV text exported from Amazon (Your Account → Request your data → Orders). Columns like "Order Date","Title","ASIN/ISBN","Category","Quantity" are recognised; duplicates by ASIN are skipped.',
    inputSchema: { csv_text: z.string().min(1) },
  }, async ({ csv_text }) => {
    let rows;
    try { rows = parseOrders(csv_text); } catch (e) { return fail(e.message); }
    const have = new Set(items().map((i) => i.asin).filter(Boolean));
    const added = rows.filter((r) => !r.asin || !have.has(r.asin)).map((r) => item(addItem(r)));
    return ok(`Imported ${added.length} of ${rows.length} orders (${rows.length - added.length} already present).`, { imported: added.length, parsed: rows.length, items: added });
  });

  server.registerTool('check_recalls', {
    title: 'Check the inventory against recall databases',
    description: 'Cross-references items against CPSC (consumer products), NHTSA (vehicles) and openFDA (food/drug/device) recalls. Returns matches with a confidence (0–1) and a short reason. Omit item_id to check everything.',
    inputSchema: { item_id: z.number().int().optional() },
  }, async ({ item_id }) => {
    const targets = item_id ? [item(item_id)].filter(Boolean) : items();
    if (item_id && !targets.length) return fail(`No item #${item_id}`);
    const upsertRecall = db.prepare('insert or replace into recalls(id, source, json, updated_at) values (?,?,?,datetime(\'now\'))');
    const upsertMatch = db.prepare('insert or replace into matches(user_id, item_id, recall_id, confidence, reason) values (?,?,?,?,?)');
    const out = [];
    // ponytail: 4 items at a time; upstream calls are cached so only the first pass per day is slow.
    for (let i = 0; i < targets.length; i += 4) {
      await Promise.all(targets.slice(i, i + 4).map(async (it) => {
        const matches = await rerank(it, rankMatches(it, await candidatesFor(db, it)).slice(0, 5));
        for (const m of matches) {
          upsertRecall.run(m.recall.id, m.recall.source, JSON.stringify(m.recall));
          upsertMatch.run(sub, it.id, m.recall.id, m.confidence, m.reason);
          out.push({ item_id: it.id, item: it.name, recall_id: m.recall.id, source: m.recall.source, title: m.recall.title, date: m.recall.date, confidence: m.confidence, level: level(m.confidence), reason: m.reason, url: m.recall.url, image: m.recall.image });
        }
      }));
    }
    out.sort((a, b) => b.confidence - a.confidence);
    const text = out.length
      ? `${out.length} possible recall${out.length > 1 ? 's' : ''} across ${targets.length} item${targets.length > 1 ? 's' : ''}:\n` + out.map((m) => `- [${m.level} ${Math.round(m.confidence * 100)}%] #${m.item_id} ${m.item} → ${m.title} (${m.recall_id}, ${m.date}) — ${m.reason}`).join('\n')
      : `Good news: no recalls matched your ${targets.length} item${targets.length > 1 ? 's' : ''}.`;
    return ok(text, { checked: targets.length, matches: out });
  });

  server.registerTool('recall_details', {
    title: 'Full details of a recall', description: 'Hazard, remedy, contact, affected products and link for a recall id returned by check_recalls (e.g. "cpsc:20062").',
    inputSchema: { recall_id: z.string() },
  }, async ({ recall_id }) => {
    const r = recall(recall_id);
    if (!r) return fail(`Unknown recall ${recall_id}; run check_recalls first.`);
    return ok(`${r.title}\nDate: ${r.date}  Source: ${r.source.toUpperCase()}\nHazard: ${r.hazard}\nRemedy: ${r.remedy}\nContact: ${r.contact}\nMore: ${r.url}`, { recall: r });
  });

  server.registerTool('start_remedy', {
    title: 'Start the remedy for a recall', description: 'Step-by-step remedy: contact info, refund/repair/replacement path, and a suggested follow-up reminder. Records that the household started it.',
    inputSchema: { recall_id: z.string(), item_id: z.number().int().optional() },
  }, async ({ recall_id, item_id }) => {
    const r = recall(recall_id);
    if (!r) return fail(`Unknown recall ${recall_id}; run check_recalls first.`);
    const plan = remedySteps(r);
    const id = db.prepare('insert into remedies(user_id, recall_id, item_id, remind_on) values (?,?,?,?)').run(sub, recall_id, item_id || null, plan.reminder.on).lastInsertRowid;
    return ok(`Remedy plan for ${r.title} (${plan.path}):\n` + plan.steps.map((s) => `${s.step}. ${s.title} — ${s.detail}`).join('\n') + `\nReminder: ${plan.reminder.on}`, { remedy_id: id, ...plan });
  });

  server.registerResource('inventory', 'household://inventory', { title: 'Household inventory', description: 'All items this household has registered', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ household: sub, items: items() }, null, 2) }] }));

  return server;
}
