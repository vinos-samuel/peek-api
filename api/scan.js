// POST /api/scan
// Accepts multipart/form-data: image file + restaurantName field
// OR application/octet-stream with ?restaurant= query param
// Returns: { dishes: [{ originalName, englishName, price, section, photoUrl, photoSource }] }

const { createClient } = require('@supabase/supabase-js');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const SEARCH_URL = 'https://www.googleapis.com/customsearch/v1';
const MEAL_DB_URL = 'https://www.themealdb.com/api/json/v1/1/search.php';

module.exports.config = {
  api: { bodyParser: false }
};

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// Read raw body from request
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Step 1: Extract dishes from menu image via Gemini ─────────────────────
async function extractDishes(imageBase64) {
  const res = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            text: `You are a menu reader. Extract every dish name from this menu photo.
Return ONLY a JSON array. Each item must have:
- "originalName": exact text from menu
- "englishName": plain English name (translate if needed, keep concise)
- "price": price string if visible (else omit)
- "section": menu section heading if visible (else omit)
No markdown. No explanation. JSON array only.`
          },
          { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }
        ]
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024 }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error ${res.status}: ${err}`);
  }

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
}

// ── Supabase cache ────────────────────────────────────────────────────────
async function getCachedPhoto(dishName) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.from('dish_photos').select('photo_url, source').eq('dish_name', dishName.toLowerCase().trim()).single();
  return data ?? null;
}

async function setCachedPhoto(dishName, photoUrl, source) {
  const sb = getSupabase();
  if (!sb) return;
  await sb.from('dish_photos').upsert({ dish_name: dishName.toLowerCase().trim(), photo_url: photoUrl, source }, { onConflict: 'dish_name' });
}

// ── TheMealDB ─────────────────────────────────────────────────────────────
async function getMealDBPhoto(dishName) {
  const res = await fetch(`${MEAL_DB_URL}?s=${encodeURIComponent(dishName)}`);
  if (!res.ok) return null;
  const json = await res.json();
  return json.meals?.[0]?.strMealThumb ?? null;
}

// ── Google Custom Search fallback ─────────────────────────────────────────
async function getSearchPhoto(dishName, restaurantName) {
  const query = restaurantName
    ? `${dishName} ${restaurantName} food dish`
    : `${dishName} food dish photo`;
  const url = `${SEARCH_URL}?key=${process.env.SEARCH_API_KEY}&cx=${process.env.SEARCH_CX}&searchType=image&num=1&q=${encodeURIComponent(query)}&imgSize=medium&safe=active`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json.items?.[0]?.link ?? null;
}

// ── Get photo for one dish ────────────────────────────────────────────────
async function getPhotoForDish(dishName, restaurantName) {
  const cached = await getCachedPhoto(dishName);
  if (cached) return cached;

  const mealDb = await getMealDBPhoto(dishName).catch(() => null);
  if (mealDb) {
    await setCachedPhoto(dishName, mealDb, 'mealdb');
    return { photo_url: mealDb, source: 'mealdb' };
  }

  const search = await getSearchPhoto(dishName, restaurantName).catch(() => null);
  if (search) {
    await setCachedPhoto(dishName, search, 'search');
    return { photo_url: search, source: 'search' };
  }

  return { photo_url: null, source: 'none' };
}

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const restaurantName = req.query?.restaurant ?? '';

    // Read raw body — image bytes sent as application/octet-stream
    const buffer = await readBody(req);
    if (!buffer.length) return res.status(400).json({ error: 'Image required' });

    const imageBase64 = buffer.toString('base64');
    console.log('Image received:', Math.round(imageBase64.length / 1024) + 'KB');

    const dishes = await extractDishes(imageBase64);
    if (!dishes.length) return res.json({ dishes: [] });

    const capped = dishes.slice(0, 12);
    const photos = await Promise.all(
      capped.map(d => getPhotoForDish(d.englishName, restaurantName))
    );

    const result = capped.map((d, i) => ({
      ...d,
      photoUrl: photos[i].photo_url,
      photoSource: photos[i].source,
    }));

    return res.json({ dishes: result });

  } catch (err) {
    console.error('Scan error:', err);
    return res.status(500).json({ error: err.message });
  }
};
