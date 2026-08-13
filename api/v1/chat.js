/**
 * Landfall — AI Chat endpoint
 * POST /api/v1/chat
 *
 * Accepts { query: string }, uses GPT-4o-mini to translate to SQL,
 * runs the query against Supabase, and returns the result with an explanation.
 */

import pg from 'pg';
import OpenAI from 'openai';

const { Pool } = pg;
let _pool = null;

function pool() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  _pool = new Pool({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 8_000,
    ssl: { rejectUnauthorized: false },
  });
  return _pool;
}

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(status).json(body);
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(res, 503, { error: 'OPENAI_API_KEY not configured on the server.' });
  }

  const db = pool();
  if (!db) {
    return json(res, 503, { error: 'DATABASE_URL not configured' });
  }

  // Parse request body
  let body = {};
  if (req.body) {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } else {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    body = JSON.parse(Buffer.concat(buffers).toString());
  }

  const userQuery = body.query;
  if (!userQuery) return json(res, 400, { error: 'Missing query parameter' });

  const schema = `
    TABLE current_accounts (
      account_id TEXT PRIMARY KEY,
      domain TEXT,
      role TEXT,
      state TEXT,
      inbound_count INTEGER,
      outbound_count INTEGER,
      refund_count INTEGER
    );
    TABLE payments (
      id BIGINT PRIMARY KEY,
      tx_hash TEXT,
      from_account TEXT,
      to_account TEXT,
      amount NUMERIC,
      asset TEXT,
      memo TEXT,
      created_at TIMESTAMPTZ,
      is_dust BOOLEAN
    );
  `;

  try {
    const apiKeys = process.env.OPENAI_API_KEY.split(',').map(k => k.trim()).filter(Boolean);
    let lastError = null;

    for (const apiKey of apiKeys) {
      try {
        const openai = new OpenAI({ apiKey });

        // Step 1: Generate SQL
        const sqlCompletion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0,
          messages: [{
            role: 'user',
            content: `You are a PostgreSQL expert for a Stellar blockchain indexer.
Schema: ${schema}
Rules:
1. Return ONLY raw SQL. No markdown fences, no explanations.
2. ALWAYS include LIMIT 50.
3. Only SELECT statements.

Request: "${userQuery}"`
          }]
        });

        let sql = sqlCompletion.choices[0].message.content.trim()
          .replace(/^```sql\n?/, '').replace(/\n?```$/, '');

        if (!sql.toUpperCase().startsWith('SELECT')) {
          throw new Error('AI generated a non-SELECT query. Refusing to run it.');
        }

        // Step 2: Execute SQL
        const { rows } = await db.query(sql);

        // Step 3: Explain results
        const explainCompletion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.5,
          messages: [{
            role: 'user',
            content: `User asked: "${userQuery}"
Database returned ${rows.length} rows. Sample: ${JSON.stringify(rows.slice(0, 3))}
Write 1-2 sentences summarizing the result in plain English.`
          }]
        });

        // If we reach here, this API key worked perfectly! Return and break loop.
        return json(res, 200, {
          explanation: explainCompletion.choices[0].message.content,
          sql,
          rows,
        });

      } catch (err) {
        // Log the failure of this specific key and continue to the next one
        console.error(`[AI Chat] Key failed: ${err.message}`);
        lastError = err;
        
        // If it's a database error (not OpenAI 401/429), break immediately.
        if (!err.status) break;
      }
    }

    // If we exhaust all keys and none worked, throw the last error
    throw lastError || new Error('All provided API keys failed.');

  } catch (err) {
    console.error('[AI Chat Fatal]', err);
    return json(res, 500, { error: 'AI query failed: ' + err.message });
  }
}
